export interface User {
  id: string;
  created: number;
  karma: number;
  about?: string;
  submitted?: number[];
}

export interface Story {
  id: number;
  by: string;
  title: string;
  url?: string;
  text?: string;
  time: number;
  score: number;
  descendants: number;
  type: "story" | "job" | "comment" | "poll" | "pollopt";
  kids?: number[];
}

export interface Comment {
  id: number;
  by: string;
  text: string;
  time: number;
  parent: number;
  type: "comment";
  kids?: number[];
}

export type HNItem = Story | Comment;

/**
 * Fetches user data by user ID from the Hacker News API.
 * Only users with public activity (comments or story submissions) are available.
 *
 * @param userId - The user's unique username (case-sensitive)
 * @returns Promise resolving to the user data
 * @throws Error if the user cannot be found or if there's a network error
 */
export async function getUser(userId: string): Promise<User> {
  if (!userId) {
    throw new Error("User ID is required");
  }

  try {
    const response = await fetch(
      `https://hacker-news.firebaseio.com/v0/user/${userId}.json`,
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch user with ID ${userId}: ${response.statusText}`,
      );
    }

    const userData = await response.json();

    if (!userData) {
      throw new Error(`User with ID ${userId} not found`);
    }

    return userData as User;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to fetch user with ID ${userId}: ${String(error)}`);
  }
}

/**
 * Fetches the list of newest story IDs from Hacker News.
 *
 * @returns Promise resolving to an array of story IDs
 */
export async function getNewStories(): Promise<number[]> {
  try {
    console.log("getNewStories: Fetching new story IDs from HackerNews API...");

    const response = await fetch(
      "https://hacker-news.firebaseio.com/v0/newstories.json",
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch new stories: ${response.statusText}`);
    }

    const stories = (await response.json()) as number[];
    console.log(
      `getNewStories: Successfully fetched ${stories.length} story IDs`,
    );

    return stories;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to fetch new stories: ${String(error)}`);
  }
}

/**
 * Fetches the list of top story IDs from Hacker News.
 *
 * @returns Promise resolving to an array of story IDs
 */
export async function getTopStories(): Promise<number[]> {
  try {
    const response = await fetch(
      "https://hacker-news.firebaseio.com/v0/topstories.json",
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch top stories: ${response.statusText}`);
    }

    return (await response.json()) as number[];
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to fetch top stories: ${String(error)}`);
  }
}

/**
 * Fetches an item (story, comment, etc) from Hacker News by its ID.
 *
 * @param itemId - The unique ID of the item to fetch
 * @returns Promise resolving to the item data or null if not found
 */
export async function getItem<T extends HNItem>(
  itemId: number,
): Promise<T | null> {
  try {
    // Uncomment for detailed debugging of individual item fetches
    // console.log(`getItem: Fetching item ${itemId}...`);

    const response = await fetch(
      `https://hacker-news.firebaseio.com/v0/item/${itemId}.json`,
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch item ${itemId}: ${response.statusText}`);
    }

    const item = await response.json();

    // Uncomment for detailed debugging of individual item results
    // if (item) {
    //   console.log(`getItem: Successfully fetched item ${itemId} (type: ${item.type})`);
    // } else {
    //   console.log(`getItem: Item ${itemId} not found (null response)`);
    // }

    return item ? (item as T) : null;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to fetch item ${itemId}: ${String(error)}`);
  }
}

/**
 * Fetches multiple items (stories, comments, etc.) from Hacker News by their IDs.
 * Uses parallel requests for better performance.
 *
 * @param itemIds - Array of item IDs to fetch
 * @param limit - Optional limit on number of items to fetch
 * @param batchSize - Optional batch size for parallel requests (default: 20)
 * @returns Promise resolving to an array of successfully fetched items
 */
export async function getItems<T extends HNItem>(
  itemIds: number[],
  limit?: number,
  batchSize = 20,
): Promise<T[]> {
  const ids = limit ? itemIds.slice(0, limit) : itemIds;

  console.log(
    `getItems: Fetching ${ids.length} items from HackerNews API in parallel...`,
  );
  let successCount = 0;
  let errorCount = 0;

  const items: T[] = [];

  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < ids.length; i += batchSize) {
    const batchIds = ids.slice(i, i + batchSize);
    console.log(
      `getItems: Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(ids.length / batchSize)} (${batchIds.length} items)`,
    );

    // Create an array of promises for this batch
    const batchPromises = batchIds.map((id) =>
      getItem<T>(id)
        .then((item) => {
          if (item !== null) {
            successCount++;
            return item;
          }
          return null;
        })
        .catch((error) => {
          console.error(`Failed to fetch item ${id}:`, error);
          errorCount++;
          return null;
        }),
    );

    // Wait for all promises in this batch to resolve
    const batchResults = await Promise.all(batchPromises);

    // Add non-null results to our items array
    items.push(
      ...batchResults.filter(
        (item): item is NonNullable<typeof item> => item !== null,
      ),
    );

    console.log(
      `getItems: Batch complete - ${successCount} successful, ${errorCount} failed so far`,
    );
  }

  console.log(
    `getItems: Completed fetching items - ${successCount} successful, ${errorCount} failed, ${items.length} total items returned`,
  );
  return items;
}

/**
 * Generates a URL to a Hacker News item.
 *
 * @param itemId - The ID of the item
 * @returns The URL to the item on Hacker News
 */
export function getItemUrl(itemId: number): string {
  return `https://news.ycombinator.com/item?id=${itemId}`;
}

/**
 * Generates a URL to a Hacker News user profile.
 *
 * @param username - The username of the user
 * @returns The URL to the user's profile on Hacker News
 */
export function getUserProfileUrl(username: string): string {
  return `https://news.ycombinator.com/user?id=${username}`;
}
