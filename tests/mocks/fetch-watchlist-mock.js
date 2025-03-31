/**
 * Mock for the fetchWatchlist function used in tests
 */

// Mock data for different test cases
const mockWatchlists = {
  // Normal case - valid watchlist
  'ur12345': {
    success: true,
    error: null,
    items: [
      { id: 'tt0111161', title: 'The Shawshank Redemption', type: 'movie', year: 1994 },
      { id: 'tt0068646', title: 'The Godfather', type: 'movie', year: 1972 },
      { id: 'tt0071562', title: 'The Godfather: Part II', type: 'movie', year: 1974 }
    ],
    created: Date.now(),
    userId: 'ur12345'
  },
  
  // User with empty watchlist
  'ur67890': {
    success: true,
    error: null,
    items: [],
    created: Date.now(),
    userId: 'ur67890'
  },
  
  // User with series in watchlist
  'ur24680': {
    success: true,
    error: null,
    items: [
      { id: 'tt0944947', title: 'Game of Thrones', type: 'series', year: 2011 },
      { id: 'tt0903747', title: 'Breaking Bad', type: 'series', year: 2008 }
    ],
    created: Date.now(),
    userId: 'ur24680'
  },
  
  // User that will fail on third sync attempt
  'ur13579': {
    success: true,
    error: null,
    items: [
      { id: 'tt0133093', title: 'The Matrix', type: 'movie', year: 1999 },
      { id: 'tt0120737', title: 'The Lord of the Rings', type: 'movie', year: 2001 }
    ],
    created: Date.now(),
    userId: 'ur13579',
    failAfter: 2 // Will fail after 2 successful fetches
  },
  
  // User that always times out
  'ur99999': {
    success: false,
    error: 'Timeout fetching watchlist',
    items: null,
    created: Date.now(),
    userId: 'ur99999',
    simulateTimeout: true
  }
};

// Track fetch counts for each user to simulate failures after certain number of attempts
const fetchCounts = {};

// Reset all fetch counts
function resetFetchCounts() {
  Object.keys(fetchCounts).forEach(key => delete fetchCounts[key]);
}

/**
 * Mock implementation of fetchWatchlist
 * @param {string} userId - IMDb user ID
 * @returns {Promise<Object>} - Watchlist data or error
 */
async function fetchWatchlistMock(userId) {
  // Initialize fetch count if not exists
  if (!fetchCounts[userId]) {
    fetchCounts[userId] = 0;
  }
  
  // Increment fetch count
  fetchCounts[userId]++;
  
  // Check if we have mock data for this user
  if (!mockWatchlists[userId]) {
    // Return a generic error for unknown users
    return {
      success: false,
      error: 'User not found',
      items: null,
      created: Date.now(),
      userId
    };
  }
  
  const mockData = { ...mockWatchlists[userId] };
  
  // If this user has a failAfter count and we've reached it, simulate a failure
  if (mockData.failAfter && fetchCounts[userId] > mockData.failAfter) {
    return {
      success: false,
      error: 'Sync failed after multiple attempts',
      items: null,
      created: Date.now(),
      userId
    };
  }
  
  // Simulate a timeout if configured
  if (mockData.simulateTimeout) {
    // Return a timeout error after a delay
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          success: false,
          error: 'Request timed out',
          items: null,
          created: Date.now(),
          userId
        });
      }, 500); // Simulate timeout after 500ms
    });
  }
  
  // Update the creation timestamp
  mockData.created = Date.now();
  
  // Return a copy of the data, not the original reference
  return {
    ...mockData,
    items: [...mockData.items] // Create a new array
  };
}

module.exports = {
  fetchWatchlistMock,
  resetFetchCounts,
  mockWatchlists
}; 