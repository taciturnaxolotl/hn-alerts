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
