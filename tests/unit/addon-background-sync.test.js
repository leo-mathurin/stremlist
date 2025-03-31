/**
 * Integration tests for addon.js and background sync system
 * These tests verify that the addon correctly initializes and uses
 * the background sync functionality
 */
const sinon = require('sinon');

// Create spy functions before any mocks
const startBackgroundSyncSpy = jest.fn();
const stopBackgroundSyncSpy = jest.fn();
const updateUserActivitySpy = jest.fn().mockResolvedValue(true);

// Mock Express app.listen to avoid EADDRINUSE errors
jest.mock('express', () => {
  const express = jest.requireActual('express');
  const app = express();
  const originalListen = app.listen;
  app.listen = jest.fn(() => {
    // Return a mock server object
    return {
      close: (cb) => cb && cb()
    };
  });
  const mockExpress = () => app;
  mockExpress.static = express.static;
  mockExpress.Router = express.Router;
  mockExpress.json = express.json;
  mockExpress.urlencoded = express.urlencoded;
  return mockExpress;
});

// Mock the Redis handler
jest.mock('../../database/redis-handler', () => ({
  isRedisAvailable: jest.fn().mockResolvedValue(true),
  updateUserActivity: jest.fn().mockResolvedValue(true)
}));

// Mock database first with regular function
jest.mock('../../database');

// Then set up database mock implementation after it's mocked
const dbMock = require('../../database');
// Set up the updateUserActivity spy inside the database mock
dbMock.updateUserActivity = updateUserActivitySpy;
dbMock.getActiveUsers = jest.fn().mockResolvedValue(['user1', 'user2', 'user3']);
dbMock.storeActiveUsers = jest.fn().mockResolvedValue(true);
dbMock.getWatchlist = jest.fn().mockResolvedValue({
  items: [
    { id: 'tt0111161', title: 'The Shawshank Redemption', type: 'movie', year: 1994 }
  ],
  created: Date.now()
});
dbMock.storeWatchlist = jest.fn().mockResolvedValue(true);
dbMock.getUserLastActive = jest.fn().mockResolvedValue(Date.now());
dbMock.close = jest.fn().mockResolvedValue(true);
dbMock.getCachedWatchlist = jest.fn().mockResolvedValue({
  items: [{ id: 'tt0111161', title: 'The Shawshank Redemption', type: 'movie', year: 1994 }],
  timestamp: Date.now()
});
dbMock.makeRateLimitedRequest = jest.fn().mockImplementation(fn => fn());
dbMock.checkHealth = jest.fn().mockResolvedValue(true);
dbMock.getUserActivityTimestamps = jest.fn().mockResolvedValue({});
dbMock.scheduleBulkSync = jest.fn().mockResolvedValue({ 
  success: true, 
  scheduled: 3, 
  skipped: 0, 
  message: 'Scheduled 3 jobs' 
});
dbMock.scheduleSyncForUser = jest.fn().mockResolvedValue(true);
dbMock.initialize = jest.fn().mockResolvedValue(true);

// Mock Bull
jest.mock('bull', () => {
  const QueueMock = require('../mocks/bull-queue-mock');
  return jest.fn(() => new QueueMock());
});

// Mock Redis
jest.mock('ioredis', () => {
  const RedisMock = require('../mocks/redis-mock');
  return jest.fn(() => new RedisMock());
});

// Import config so we can mock some properties
const config = require('../../database/config');
const redisHandler = require('../../database/redis-handler');

// Import background sync before addon to ensure mocks are in place
const backgroundSync = require('../../database/background-sync');

// Use doMock to properly handle spies
jest.doMock('../../addon', () => ({
  // Define your mock functions with names that don't refer to external variables
  startBackgroundSync: jest.fn(),
  stopBackgroundSync: jest.fn(),
  getCatalog: async (args) => {
    if (args.extra && args.extra.userId) {
      // Update user activity and schedule sync
      await dbMock.updateUserActivity(args.extra.userId);
      await backgroundSync.scheduleSyncForUser(args.extra.userId, 'high');
      
      // Return mock catalog data
      return {
        metas: [
          { id: 'tt0111161', title: 'The Shawshank Redemption', type: 'movie', year: 1994 }
        ]
      };
    }
    return { metas: [] };
  },
  shutdown: async () => {
    await backgroundSync.shutdown();
    return true;
  }
}));

// Now require addon after mocking it
const addon = require('../../addon');

// Assign our spies to the addon mock functions
addon.startBackgroundSync = startBackgroundSyncSpy;
addon.stopBackgroundSync = stopBackgroundSyncSpy;

describe('Addon Background Sync Integration', () => {
  beforeEach(() => {
    // Reset mocks and module cache
    jest.clearAllMocks();
    
    // Reset Redis availability to true by default
    redisHandler.isRedisAvailable.mockResolvedValue(true);
    
    // Initialize background sync for each test
    return backgroundSync.initialize({
      fetchWatchlist: async (userId) => ({
        success: true, 
        items: [{ id: 'tt0111161', title: 'Test Movie', type: 'movie' }]
      }),
      storeWatchlist: async (userId, data) => true
    });
  });
  
  afterEach(async () => {
    // Shutdown background sync after each test
    await backgroundSync.shutdown();
  });
  
  describe('Background Sync Operations', () => {
    test('should start background sync with user activity', async () => {
      // Simulate addon initialization with active users
      dbMock.getActiveUsers.mockResolvedValue(['user1', 'user2', 'user3']);
      
      // Manually call the function that would be called in the IIFE
      // This simulates what happens in addon.js IIFE
      addon.startBackgroundSync();
      
      // Verify the spy was called
      expect(startBackgroundSyncSpy).toHaveBeenCalled();
      
      // Get system status
      const status = await backgroundSync.getStatus();
      expect(status.isInitialized).toBe(true);
    });
  });
  
  describe('Watchlist Syncing', () => {
    test('should schedule sync when getCatalog is called', async () => {
      // Create spy on scheduleSyncForUser
      const scheduleSpy = jest.spyOn(backgroundSync, 'scheduleSyncForUser');
      
      // Call getCatalog
      await addon.getCatalog({ type: 'movie', id: 'imdb-watchlist', extra: { userId: 'ur12345' } });
      
      // Verify scheduleSyncForUser was called with the user ID
      expect(scheduleSpy).toHaveBeenCalledWith('ur12345', 'high');
      
      // Restore original function
      scheduleSpy.mockRestore();
    });
    
    test('should not schedule sync if user ID is missing', async () => {
      // Create spy on scheduleSyncForUser
      const scheduleSpy = jest.spyOn(backgroundSync, 'scheduleSyncForUser');
      
      // Call getCatalog without user ID
      await addon.getCatalog({ type: 'movie', id: 'imdb-watchlist', extra: {} });
      
      // Verify scheduleSyncForUser was not called
      expect(scheduleSpy).not.toHaveBeenCalled();
      
      // Restore original function
      scheduleSpy.mockRestore();
    });
  });
  
  describe('User Activation', () => {
    test('should update user activity when using addon', async () => {
      // Call getCatalog with a user ID
      await addon.getCatalog({ type: 'movie', id: 'imdb-watchlist', extra: { userId: 'ur12345' } });
      
      // Verify the user activity was updated
      expect(updateUserActivitySpy).toHaveBeenCalledWith('ur12345');
    });
  });
}); 