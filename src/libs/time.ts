// Helper function for pretty-printing time
export const prettyPrintTime = (ms: number): string => {
	const hours = Math.floor(ms / 3600000);
	const minutes = Math.floor((ms % 3600000) / 60000);

	if (hours > 0 && minutes > 5) {
		return `${hours} hours and ${minutes} minutes`;
	}
	if (hours > 0) {
		return `${hours} hours`;
	}
	if (minutes < 2) {
		const seconds = Math.max(0, Math.round(ms / 1000));
		return `${seconds} seconds`;
	}
	return `${minutes} minutes`;
};

// Helper function that generates the slack date format
export const generateSlackDate = (endTime: Date): string => {
	return `<!date^${Math.floor(endTime.getTime() / 1000)}^{time}|${endTime.toLocaleTimeString()}>`;
};

/**
 * Add days to a date
 * @param date The date to add days to
 * @param days Number of days to add
 * @returns New date with days added
 */
export const addDays = (date: Date, days: number): Date => {
  const result = new Date(date);
  result.setDate(date.getDate() + days);
  return result;
};

/**
 * Add hours to a date
 * @param date The date to add hours to
 * @param hours Number of hours to add
 * @returns New date with hours added
 */
export const addHours = (date: Date, hours: number): Date => {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
};

/**
 * Convert a timestamp in seconds to a Date object
 * @param timestamp Timestamp in seconds
 * @returns Date object
 */
export const secondsToDate = (timestamp: number): Date => {
  return new Date(timestamp * 1000);
};

/**
 * Get current timestamp in seconds
 * @returns Current timestamp in seconds
 */
export const getCurrentTimestampInSeconds = (): number => {
  return Math.floor(Date.now() / 1000);
};
