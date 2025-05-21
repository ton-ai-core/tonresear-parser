import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import * as cheerio from 'cheerio'; // Import cheerio
import TurndownService from 'turndown'; // Import Turndown
import {
  LatestJsonResponse,
  Topic,
  Progress,
  SavedTopicMetadata
} from './interfaces';

const BASE_URL = 'https://tonresear.ch';
const TOPICS_API_BASE_PATH = '/latest.json?ascending=true&no_definitions=true&order=activity';

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROGRESS_FILE_PATH = path.join(DATA_DIR, 'progress.json');
const TOPICS_METADATA_FILE_PATH = path.join(DATA_DIR, 'latest_topics_metadata.json');
const TOPIC_PAGES_MD_DIR = path.join(DATA_DIR, 'topic_pages_md'); // Changed directory name
const CHUNKED_MD_DIR = path.join(DATA_DIR, 'markdown'); // Директория для чанкированных markdown-файлов
const REQUEST_DELAY_MS = 250; // Delay between API requests
const HTML_DOWNLOAD_DELAY_MS = 500; // Delay between HTML downloads
const METADATA_SAVE_INTERVAL = 50; // Save metadata every 50 HTML processing attempts
const CHUNK_SIZE_KB = 950; // Target size for markdown chunks in KB

// Initialize Turndown service
const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced'
});

// --- Utility Functions ---

async function loadProgress(): Promise<Progress> {
  const defaultProgress: Progress = {
    latest_topic_bumped_at: null,
    last_processed_api_page: null,
    last_processed_html_topic_id: null,
  };
  try {
    if (await fs.pathExists(PROGRESS_FILE_PATH)) {
      const progressData = await fs.readJson(PROGRESS_FILE_PATH);
      // Merge saved data with defaults to ensure all keys exist
      return { ...defaultProgress, ...progressData };
    }
  } catch (error) {
    console.warn(`Error loading progress file ${PROGRESS_FILE_PATH}, starting fresh:`, error);
  }
  return defaultProgress;
}

// Debounce saveProgress to avoid excessive writes during rapid HTML processing
let saveTimeout: NodeJS.Timeout | null = null;
let progressToSave: Progress | null = null;

async function saveProgress(progress: Progress): Promise<void> {
    try {
        const dataToSave = { ...progress };
        await fs.ensureDir(DATA_DIR);
        await fs.writeJson(PROGRESS_FILE_PATH, dataToSave, { spaces: 2 });
        // Adjusted log slightly
        console.log(`Saved progress: API page ${dataToSave.last_processed_api_page}, Markdown Topic ID ${dataToSave.last_processed_html_topic_id}`);
    } catch (error) {
        console.error(`Error saving progress to ${PROGRESS_FILE_PATH}:`, error);
    }
}

// Type for the structure stored in the metadata file: Record<topicId, metadata>
type TopicsMetadataStore = Record<number, SavedTopicMetadata>;

async function loadTopicsMetadata(): Promise<TopicsMetadataStore> {
  try {
    if (await fs.pathExists(TOPICS_METADATA_FILE_PATH)) {
      const metadata = await fs.readJson(TOPICS_METADATA_FILE_PATH);
      // Ensure it's an object, not an array or something else
      if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
           return metadata as TopicsMetadataStore;
      } else {
          console.warn(`Metadata file ${TOPICS_METADATA_FILE_PATH} is not a valid object. Starting fresh.`);
      }
    }
  } catch (error) {
    console.warn(`Error loading topics metadata file ${TOPICS_METADATA_FILE_PATH}, starting fresh:`, error);
  }
  return {}; // Return empty object if file doesn't exist or fails to load/validate
}

async function saveTopicsMetadata(metadata: TopicsMetadataStore, immediate: boolean = false): Promise<void> {
  if (!immediate && Object.keys(metadata).length % METADATA_SAVE_INTERVAL !== 0 && Object.keys(metadata).length > 0) {
    console.warn(`Metadata save interval not reached. Metadata not saved.`);
    return;
  }
  try {
    const sortedKeys = Object.keys(metadata).map(Number).sort((a, b) => a - b);
    const sortedMetadata: TopicsMetadataStore = {};
    for (const key of sortedKeys) {
      sortedMetadata[key] = metadata[key];
    }
    await fs.ensureDir(DATA_DIR);
    await fs.writeJson(TOPICS_METADATA_FILE_PATH, sortedMetadata, { spaces: 2 });
    console.log(`Saved topics metadata to ${TOPICS_METADATA_FILE_PATH}`);
  } catch (error) {
    console.error(`Error saving topics metadata to ${TOPICS_METADATA_FILE_PATH}:`, error);
  }
}

async function fetchLatestTopicsPage(urlPath: string): Promise<LatestJsonResponse | null> {
  try {
    const fullUrl = urlPath.startsWith('http') ? urlPath : `${BASE_URL}${urlPath}`;
    console.log(`Fetching topics from: ${fullUrl}`);
    const response = await axios.get<LatestJsonResponse>(fullUrl, {
      timeout: 20000,
      headers: {
        // Add a common browser User-Agent header
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (response && response.data) {
        const hasTopicList = !!response.data.topic_list;
        const hasTopicsArray = !!(hasTopicList && response.data.topic_list.topics);
        console.log(` Successfully fetched page. Has topic_list: ${hasTopicList}, Has topics array: ${hasTopicsArray}`);
        if (!hasTopicList) {
            console.warn(` Warning: Response data for ${fullUrl} is missing 'topic_list'. Response keys: ${Object.keys(response.data)}`);
            // Return the data even if topic_list is missing, maybe more_topics_url is still there?
            // Or return null? Let's return the data for now to see if more_topics_url exists.
            // return null; 
        }
        // It's okay if topics array is missing/empty on the last page
        if (hasTopicsArray) {
            console.log(` Number of topics on this page: ${response.data.topic_list.topics.length}`);
        }
        return response.data;
    } else {
        console.warn(` Received empty or invalid response from ${fullUrl}`);
        return null;
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(` Error fetching topics from ${urlPath}:`, errorMessage);
    // Log additional details if available (like status code)
    if (axios.isAxiosError(error) && error.response) {
        console.error(`   Status: ${error.response.status}, Response: ${JSON.stringify(error.response.data).substring(0, 100)}...`);
    }
    return null;
  }
}

// --- Phase 1: Fetching Topic Metadata ---
async function fetchAllTopics(
  apiBasePath: string,
  progress: Progress
): Promise<{ topics: Topic[]; newLatestBumpedAt: string | null }> {
  console.log('\n--- Starting Phase 1: Fetching topic metadata (Iterating by page number) ---');
  let collectedTopics: Topic[] = [];
  // Start AT the last successfully processed page (or 0 if null/negative)
  let startPageNumber = (progress.last_processed_api_page === null || progress.last_processed_api_page < 0) 
                          ? 0 
                          : progress.last_processed_api_page;
  let currentPageNumber = startPageNumber;
  console.log(`Phase 1: Starting API check from page ${startPageNumber}`);

  let pagesFetchedThisRun = 0;
  let accumulatedTopicsCount = 0;
  let runLatestBumpedAtDate: Date = progress.latest_topic_bumped_at
    ? new Date(progress.latest_topic_bumped_at)
    : new Date(0);

  const progressTimestampDate = progress.latest_topic_bumped_at
    ? new Date(progress.latest_topic_bumped_at)
    : null;

  console.log(`Starting from API page: ${currentPageNumber}`);
  console.log(`Fetching topics bumped after: ${progressTimestampDate?.toISOString() ?? 'the beginning'}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    pagesFetchedThisRun++;
    const pageUrl = `${apiBasePath}&page=${currentPageNumber}`;
    console.log(`\nFetching page ${pagesFetchedThisRun} (page number ${currentPageNumber})...`);
    const pageData = await fetchLatestTopicsPage(pageUrl);

    if (!pageData) {
      console.error(` Failed to fetch page ${pagesFetchedThisRun} at ${pageUrl}. Stopping pagination.`);
      break;
    }

    if (pageData.topic_list && Array.isArray(pageData.topic_list.topics)) {
      const topicsOnPage = pageData.topic_list.topics;

      if (topicsOnPage.length === 0) {
        console.log(` Page ${pagesFetchedThisRun} (${pageUrl}) returned 0 topics. Assuming end of pagination.`);
        // Successfully processed the *previous* page, update progress before breaking
        progress.last_processed_api_page = currentPageNumber -1;
        await saveProgress(progress); // Save immediately before stopping
        break;
      }

      accumulatedTopicsCount += topicsOnPage.length;
      let newTopicsFromPage = 0;
      let hitOlderTopic = false;

      for (const topic of topicsOnPage) {
        try {
          const topicBumpedAtDate = new Date(topic.bumped_at);
          if (!progressTimestampDate || topicBumpedAtDate > progressTimestampDate) {
            collectedTopics.push(topic);
            newTopicsFromPage++;
            if (topicBumpedAtDate > runLatestBumpedAtDate) {
              runLatestBumpedAtDate = topicBumpedAtDate;
            }
          } else {
            console.log(` Hit topic ${topic.id} (bumped ${topic.bumped_at}) not newer than progress timestamp ${progressTimestampDate?.toISOString()}. Stopping processing for this page.`);
            hitOlderTopic = true;
            // Don't break the outer loop, just this inner one
            // break;
          }
        } catch (parseError) {
          console.error(`Error processing date for topic ID ${topic?.id}:`, parseError);
          continue;
        }
      }
      console.log(` Processed ${topicsOnPage.length} topics on page ${pagesFetchedThisRun}. Collected ${newTopicsFromPage} new/updated.`);

      // --- Save progress AFTER successfully processing the page --- 
      progress.last_processed_api_page = currentPageNumber;
      await saveProgress(progress); // Debounced save
      // ----------------------------------------------------------

      // If we hit an older topic, we can potentially stop, but it's safer to continue
      // to the next page number in case of minor ordering issues across pages.
      if (hitOlderTopic) {
           console.log(" Older topics encountered on this page, continuing to next page just in case.");
           // Consider breaking here if performance is critical and API order is guaranteed
      }

    } else {
      console.warn(` Page ${pagesFetchedThisRun} (${pageUrl}) loaded but missing 'topic_list.topics' array or 'topic_list'. Assuming end of pagination or error.`);
      // Don't update progress, as the page wasn't fully processed/valid
      break;
    }

    currentPageNumber++;
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  console.log(`\nPhase 1 Finished. Total pages fetched this run: ${pagesFetchedThisRun}. Total topics seen on these pages: ${accumulatedTopicsCount}.`);

  const finalNewLatestBumpedAt = (collectedTopics.length > 0 || progressTimestampDate)
    ? runLatestBumpedAtDate.toISOString()
    : progress.latest_topic_bumped_at; // Keep old value if no new topics found

  console.log(`Total new/updated topics collected in this run: ${collectedTopics.length}`);
  console.log(`New 'latest_topic_bumped_at' for progress file: ${finalNewLatestBumpedAt ?? '(no change)'}`);

  return { topics: collectedTopics, newLatestBumpedAt: finalNewLatestBumpedAt };
}

// --- Phase 2: Saving Topic Markdown ---
async function processTopicsForMarkdown(
  allMetadata: TopicsMetadataStore,
  progress: Progress
): Promise<void> {
  const allTopicIds = Object.keys(allMetadata).map(Number);
  allTopicIds.sort((a, b) => a - b);

  console.log(`\n--- Starting Phase 2: Processing Markdown for ${allTopicIds.length} total known topics ---`);
  await fs.ensureDir(TOPIC_PAGES_MD_DIR); // Ensure MD directory exists

  let processedCount = 0;
  let attemptedInThisRun = 0;
  const lastProcessedId = progress.last_processed_html_topic_id ?? -1; // Still using this field name for now
  console.log(`Resuming Markdown processing after topic ID: ${lastProcessedId}`);

  for (const topicId of allTopicIds) {
    processedCount++;
    if (topicId <= lastProcessedId) {
      continue;
    }

    const topicMeta = allMetadata[topicId];
    if (!topicMeta) {
      console.warn(`Metadata for topic ID ${topicId} not found in store. Skipping.`);
      continue;
    }

    // Skip if metadata already indicates saved status
    if (topicMeta.markdown_saved) { // Check new field
      if (topicId > (progress.last_processed_html_topic_id ?? -1)) {
        progress.last_processed_html_topic_id = topicId;
        await saveProgress(progress); 
      }
      continue;
    }

    attemptedInThisRun++;
    const topicUrl = `${BASE_URL}/t/${topicMeta.slug}/${topicMeta.id}`;
    const filePath = path.join(TOPIC_PAGES_MD_DIR, `${topicMeta.id}.md`); // Save as .md
    let success = false;
    let errorMsg: string | null = null;

    console.log(`\nProcessing Markdown for topic ${topicMeta.id}: ${topicMeta.title} (Attempt ${attemptedInThisRun} in this run)`);
    console.log(` - Downloading HTML from ${topicUrl}...`);
    try {
      await new Promise(resolve => setTimeout(resolve, HTML_DOWNLOAD_DELAY_MS));
      const response = await axios.get(topicUrl, { responseType: 'text', timeout: 30000 });
      
      console.log(' - Extracting content and converting to Markdown...');
      const $ = cheerio.load(response.data);
      // Select the main content area - adjust selector if needed
      const htmlContent = $('#main-outlet .container.posts').html(); 
      
      if (!htmlContent) {
          // Fallback if specific selector fails, try the whole body (minus scripts)
          console.warn(`   Selector '#main-outlet .container.posts' not found for ${topicId}, falling back to body content.`);
          $('body script').remove(); // Remove scripts from body
          const bodyHtml = $('body').html();
          if (!bodyHtml) throw new Error('Could not extract HTML content (body or specific selector).');
          const markdownContent = turndownService.turndown(bodyHtml);
          await fs.writeFile(filePath, markdownContent);
      } else {
          const markdownContent = turndownService.turndown(htmlContent);
          await fs.writeFile(filePath, markdownContent);
      }

      console.log(` - Successfully saved MARKDOWN to ${filePath}`);
      success = true;
    } catch (error) {
      const specificErrorMessage = error instanceof Error ? error.message : String(error);
      console.error(` - Error processing Markdown for topic ${topicMeta.id}:`, specificErrorMessage);
      errorMsg = specificErrorMessage;
      success = false;
      if (await fs.pathExists(filePath)) await fs.remove(filePath);
    }

    // Update metadata status IN MEMORY
    allMetadata[topicId].markdown_saved = success; // Use new field
    allMetadata[topicId].markdown_error = errorMsg; // Use new field
    allMetadata[topicId].last_processed_at = new Date().toISOString();

    // Save progress AFTER processing this topic ID
    progress.last_processed_html_topic_id = topicId;
    await saveProgress(progress);

    // Save metadata checkpoint periodically
    if (attemptedInThisRun > 0 && attemptedInThisRun % METADATA_SAVE_INTERVAL === 0) {
      console.log(` --- Saving metadata checkpoint (${attemptedInThisRun} attempts this run) ---`);
      await saveTopicsMetadata(allMetadata);
    }
  }
  console.log(`\n--- Finished Phase 2 attempt. Processed ${processedCount} total topics. Attempted ${attemptedInThisRun} downloads/conversions in this run. ---`);
}

// Function to generate chunked markdown files
async function generateChunkedMarkdownFiles(): Promise<void> {
  console.log('\n--- Starting Phase 3: Generating chunked markdown files ---');
  
  // Ensure the chunked markdown directory exists
  await fs.ensureDir(CHUNKED_MD_DIR);
  
  // Check if the topic_pages_md directory exists and has files
  if (!(await fs.pathExists(TOPIC_PAGES_MD_DIR))) {
    console.warn(`Topic pages directory ${TOPIC_PAGES_MD_DIR} does not exist. Skipping chunking.`);
    return;
  }
  
  // Get all markdown files
  const mdFiles = await fs.readdir(TOPIC_PAGES_MD_DIR);
  const markdownFiles = mdFiles.filter(file => file.endsWith('.md'));
  
  if (markdownFiles.length === 0) {
    console.warn('No markdown files found to chunk. Skipping chunking phase.');
    return;
  }
  
  console.log(`Found ${markdownFiles.length} markdown files to process.`);
  
  // Read all markdown files and concatenate their content
  let allContent = '';
  for (const file of markdownFiles) {
    const filePath = path.join(TOPIC_PAGES_MD_DIR, file);
    const content = await fs.readFile(filePath, 'utf-8');
    // Add file header to identify the source in chunked files
    allContent += `\n\n## Topic: ${path.basename(file, '.md')}\n\n${content}\n\n`;
  }
  
  // Calculate total size and prepare for chunking
  const contentSizeKB = Buffer.byteLength(allContent, 'utf-8') / 1024;
  const estimatedChunks = Math.ceil(contentSizeKB / CHUNK_SIZE_KB);
  
  console.log(`Total content size: ${contentSizeKB.toFixed(2)} KB`);
  console.log(`Estimated number of chunks needed: ${estimatedChunks}`);
  
  // Create chunks
  const chunkSizeBytes = CHUNK_SIZE_KB * 1024;
  let currentChunk = '';
  let currentChunkSize = 0;
  let chunkIndex = 1;
  
  // Split by paragraphs to avoid breaking in the middle of text
  const paragraphs = allContent.split('\n\n');
  
  for (const paragraph of paragraphs) {
    const paragraphSize = Buffer.byteLength(paragraph + '\n\n', 'utf-8');
    
    // If adding this paragraph would exceed the chunk size, save current chunk and start a new one
    if (currentChunkSize + paragraphSize > chunkSizeBytes && currentChunkSize > 0) {
      await fs.writeFile(
        path.join(CHUNKED_MD_DIR, `tonresear_part${chunkIndex}.md`),
        currentChunk
      );
      console.log(`Created chunk ${chunkIndex} with size ${(currentChunkSize / 1024).toFixed(2)} KB`);
      
      // Reset for next chunk
      currentChunk = '';
      currentChunkSize = 0;
      chunkIndex++;
    }
    
    // Add paragraph to current chunk
    currentChunk += paragraph + '\n\n';
    currentChunkSize += paragraphSize;
  }
  
  // Save the last chunk if it has content
  if (currentChunkSize > 0) {
    await fs.writeFile(
      path.join(CHUNKED_MD_DIR, `tonresear_part${chunkIndex}.md`),
      currentChunk
    );
    console.log(`Created chunk ${chunkIndex} with size ${(currentChunkSize / 1024).toFixed(2)} KB`);
  }
  
  console.log(`\n--- Finished Phase 3: Created ${chunkIndex} markdown chunks in ${CHUNKED_MD_DIR} ---`);
}

// --- Main Execution Logic ---
async function main() {
  console.log('Script started.');
  await fs.ensureDir(DATA_DIR);

  // Load state
  let currentProgress = await loadProgress();
  const allMetadata = await loadTopicsMetadata();
  console.log(`Loaded ${Object.keys(allMetadata).length} existing topic metadata entries.`);
  console.log(`Initial progress loaded: ${JSON.stringify(currentProgress)}`);

  // --- Phase 1: Fetch topic list updates ---
  const { topics: newlyFetchedRawTopics, newLatestBumpedAt } =
    await fetchAllTopics(TOPICS_API_BASE_PATH, currentProgress);

  // Update progress object with the latest bumped_at from Phase 1
  // This might be the same as before if no new topics were actually newer
  currentProgress.latest_topic_bumped_at = newLatestBumpedAt;

  const fetchTimestamp = new Date().toISOString();
  let updatedMetadataCount = 0;
  let newTopicsCount = 0;

  // Update the central metadata store
  newlyFetchedRawTopics.forEach(topic => {
    const existingEntry = allMetadata[topic.id];
    const isNew = !existingEntry;
    if (isNew) newTopicsCount++;
    updatedMetadataCount++;

    const newEntry: SavedTopicMetadata = {
      ...topic,
      fetch_timestamp: fetchTimestamp,
      // Use new field names, preserve existing status if updated
      markdown_saved: existingEntry?.markdown_saved ?? false,
      markdown_error: existingEntry?.markdown_error ?? null,
      last_processed_at: existingEntry?.last_processed_at ?? null,
    };
    if (isNew || (existingEntry && new Date(topic.bumped_at) > new Date(existingEntry.bumped_at))) {
      // Mark for reprocessing Markdown if topic was updated
      newEntry.markdown_saved = false; 
      newEntry.markdown_error = null;
      newEntry.last_processed_at = null;
      console.log(`Marking topic ${topic.id} for Markdown reprocessing due to update or being new.`);
    }
    allMetadata[topic.id] = newEntry;
  });

  console.log(`Phase 1 Results: Added/updated ${updatedMetadataCount} topics (${newTopicsCount} new) in memory.`);

  // Save updated metadata from Phase 1 BEFORE starting phase 2
  if (updatedMetadataCount > 0) {
    await saveTopicsMetadata(allMetadata);
  }

  // --- Phase 2: Convert HTML to Markdown for ALL known topics ---
  await processTopicsForMarkdown(allMetadata, currentProgress);

  // --- Phase 3: Generate chunked markdown files ---
  await generateChunkedMarkdownFiles();

  // --- Save final state ---
  await saveTopicsMetadata(allMetadata);
  await saveProgress(currentProgress);

  console.log(`\nScript finished.`);
  console.log(`Total topics now in metadata file: ${Object.keys(allMetadata).length}`);
}

main().catch(async (error) => {
  console.error('FATAL: Unhandled error in main function:', error);
  console.error("Attempting emergency progress save...");
  try {
      // Reload progress to ensure we save the absolute latest state written by background tasks
      const finalProgress = await loadProgress(); 
      await saveProgress(finalProgress); 
  } catch (saveError) {
      console.error("Emergency progress save failed:", saveError);
  } finally {
       process.exit(1);
  }
}); 