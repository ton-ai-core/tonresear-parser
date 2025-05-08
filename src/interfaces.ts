export interface TopicPoster {
  extras: string | null;
  description: string;
  user_id: number;
  primary_group_id: number | null;
  flair_group_id: number | null;
}

// Interface for the raw topic object from the API
export interface Topic {
  id: number;
  title: string;
  fancy_title: string;
  slug: string;
  posts_count: number;
  reply_count: number;
  highest_post_number: number;
  image_url: string | null;
  created_at: string;
  last_posted_at: string;
  bumped: boolean;
  bumped_at: string;
  archetype: string;
  unseen: boolean;
  pinned: boolean;
  unpinned: null; // Assuming type, adjust if known
  visible: boolean;
  closed: boolean;
  archived: boolean;
  bookmarked: null; // Assuming type, adjust if known
  liked: null; // Assuming type, adjust if known
  tags: string[];
  tags_descriptions?: Record<string, string>;
  views: number;
  like_count: number;
  has_summary: boolean;
  last_poster_username: string;
  category_id: number;
  pinned_globally: boolean;
  featured_link: string | null;
  posters: TopicPoster[];
}

// Interface for the structure of the latest.json response
export interface LatestJsonResponse {
  users?: any[]; // Define User interface if needed later
  primary_groups?: any[]; // Define Group interface if needed later
  topic_list: {
    can_create_topic: boolean;
    more_topics_url?: string;
    per_page: number;
    topics: Topic[];
  };
}

// Interface for the metadata we store about each topic in the JSON file
// It extends the raw Topic data with fields relevant to our processing.
export interface SavedTopicMetadata extends Topic {
  fetch_timestamp: string;
  markdown_saved: boolean;
  markdown_error?: string | null;
  last_processed_at: string | null;
}

// Interface for the progress file
export interface Progress {
  /**
   * The 'bumped_at' timestamp of the most recently seen/processed topic
   * from any page of latest.json on the last successful run.
   * Used to fetch only topics bumped after this time in subsequent runs.
   * Null if no topics have been processed yet.
   */
  latest_topic_bumped_at: string | null;

  /**
   * The page number (0-indexed) of the last successfully fetched and processed
   * page from the latest.json API during Phase 1.
   * Null if no pages have been processed yet.
   */
  last_processed_api_page: number | null;

  /**
   * The ID of the last topic for which HTML processing was attempted (either success or failure)
   * during Phase 2.
   * Null if no topics have been processed yet in Phase 2.
   */
  last_processed_html_topic_id: number | null;
}

export interface TopicList {
  can_create_topic: boolean;
  more_topics_url: string | null; // Важно для пагинации
  per_page: number;
  top_tags: string[];
  topics: Topic[];
}