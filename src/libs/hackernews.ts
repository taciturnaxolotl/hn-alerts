export interface User {
  id: string;
  created: number;
  karma: number;
  about?: string;
  submitted?: number[];
}

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
