/**
 * Unit tests for job-queue.js module
 */
const sinon = require('sinon');

// Mock Bull
jest.mock('bull', () => {
  const QueueMock = require('../mocks/bull-queue-mock');
  return jest.fn(() => new QueueMock());
});

// Mock Redis handler - ensure isRedisAvailable returns true consistently
jest.mock('../../database/redis-handler', () => ({
  isRedisAvailable: jest.fn().mockResolvedValue(true),
  updateUserActivity: jest.fn().mockResolvedValue(true)
}));

// Import after mocking
const jobQueue = require('../../database/job-queue');
const config = require('../../database/config');
// Get the redis-handler mock to manipulate in tests
const redisHandler = require('../../database/redis-handler');

describe('Job Queue Module', () => {
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Reset module state by closing
    if (typeof jobQueue.closeQueue === 'function') {
      jobQueue.closeQueue();
    }
    
    // Ensure isRedisAvailable returns true by default for each test
    redisHandler.isRedisAvailable.mockResolvedValue(true);
  });
  
  afterAll(async () => {
    if (typeof jobQueue.closeQueue === 'function') {
      await jobQueue.closeQueue();
    }
  });
  
  describe('Initialization', () => {
    test('should successfully initialize with Redis available', async () => {
      const result = await jobQueue.initialize();
      expect(result).toBe(true);
    });
    
    test('should fail initialization if Redis is not available', async () => {
      // Mock isRedisAvailable to return false for this specific test
      redisHandler.isRedisAvailable.mockResolvedValueOnce(false);
      
      const result = await jobQueue.initialize();
      expect(result).toBe(false);
    });
    
    test('should not initialize if Redis is disabled', async () => {
      // Mock Redis disabled config
      const originalRedisEnabled = config.REDIS_ENABLED;
      Object.defineProperty(config, 'REDIS_ENABLED', {
        get: jest.fn(() => false),
        configurable: true
      });
      
      const result = await jobQueue.initialize();
      expect(result).toBe(false);
      
      // Restore original config
      Object.defineProperty(config, 'REDIS_ENABLED', {
        get: jest.fn(() => originalRedisEnabled),
        configurable: true
      });
    });
  });
  
  describe('Job Management', () => {
    beforeEach(async () => {
      // Initialize queue for each test
      await jobQueue.initialize();
    });
    
    test('should schedule a job with default options', async () => {
      const job = await jobQueue.scheduleUserSync('ur12345');
      
      expect(job).toBeTruthy();
      expect(job.data).toEqual(expect.objectContaining({
        userId: 'ur12345',
        timestamp: expect.any(Number)
      }));
    });
    
    test('should schedule jobs with different priorities', async () => {
      const highJob = await jobQueue.scheduleUserSync('ur12345', 'high');
      const normalJob = await jobQueue.scheduleUserSync('ur67890', 'normal');
      const lowJob = await jobQueue.scheduleUserSync('ur24680', 'low');
      
      expect(highJob.opts.priority).toBeLessThan(normalJob.opts.priority);
      expect(normalJob.opts.priority).toBeLessThan(lowJob.opts.priority);
    });
    
    test('should check if a user has an active job', async () => {
      // Schedule a job
      await jobQueue.scheduleUserSync('ur12345');
      
      // Check if the user has an active job
      const hasJob = await jobQueue.hasActiveJob('ur12345');
      expect(hasJob).toBe(true);
      
      // Check for a user without an active job
      const noJob = await jobQueue.hasActiveJob('nonexistent');
      expect(noJob).toBe(false);
    });
    
    test('should get the sync queue', () => {
      const queue = jobQueue.getSyncQueue();
      expect(queue).toBeTruthy();
    });
  });
  
  describe('Queue Statistics', () => {
    beforeEach(async () => {
      // Initialize queue for each test
      await jobQueue.initialize();
    });
    
    test('should get queue statistics', async () => {
      // Add some jobs
      await jobQueue.scheduleUserSync('ur12345');
      await jobQueue.scheduleUserSync('ur67890');
      
      // Get statistics
      const stats = await jobQueue.getQueueStats();
      
      expect(stats).toHaveProperty('isActive', true);
      expect(stats).toHaveProperty('stats');
      expect(stats.stats).toHaveProperty('counts');
      expect(stats.stats.counts).toHaveProperty('waiting', 2);
    });
    
    test('should handle empty queue statistics', async () => {
      // Get statistics for empty queue
      const stats = await jobQueue.getQueueStats();
      
      expect(stats).toHaveProperty('isActive', true);
      expect(stats).toHaveProperty('stats');
      expect(stats.stats).toHaveProperty('counts');
      expect(stats.stats.counts).toHaveProperty('waiting', 0);
    });
  });
  
  describe('Queue Shutdown', () => {
    beforeEach(async () => {
      // Initialize queue for each test
      await jobQueue.initialize();
    });
    
    test('should close the queue', async () => {
      // Schedule a job
      await jobQueue.scheduleUserSync('ur12345');
      
      // Close the queue
      await jobQueue.closeQueue();
      
      // Queue should no longer be available
      const queue = jobQueue.getSyncQueue();
      expect(queue).toBeFalsy();
    });
  });
  
  describe('Error Handling', () => {
    beforeEach(async () => {
      await jobQueue.initialize();
    });
    
    test('should handle errors when adding jobs', async () => {
      // Mock the queue's add method to throw an error
      const queue = jobQueue.getSyncQueue();
      const originalAdd = queue.add;
      
      // Use a more specific error with a proper stack trace
      const testError = new Error('Test error');
      queue.add = jest.fn().mockRejectedValue(testError);
      
      // Attempt to schedule a job
      const job = await jobQueue.scheduleUserSync('ur12345');
      
      // Should return null on error
      expect(job).toBeNull();
      
      // Restore original method
      queue.add = originalAdd;
    });
    
    test('should handle errors when checking for active jobs', async () => {
      // Mock the queue's getWaiting method to throw an error
      const queue = jobQueue.getSyncQueue();
      const originalGetWaiting = queue.getWaiting;
      
      // Use a specific error with proper stack trace
      const testError = new Error('Test error');
      queue.getWaiting = jest.fn().mockRejectedValue(testError);
      
      // Check if a user has an active job
      const hasJob = await jobQueue.hasActiveJob('ur12345');
      
      // Should return false on error
      expect(hasJob).toBe(false);
      
      // Restore original method
      queue.getWaiting = originalGetWaiting;
    });
    
    test('should handle errors when getting stats', async () => {
      // Mock the queue's getJobCounts method to throw an error
      const queue = jobQueue.getSyncQueue();
      const originalGetJobCounts = queue.getJobCounts;
      
      // Use a specific error with proper stack trace
      const testError = new Error('Test error');
      queue.getJobCounts = jest.fn().mockRejectedValue(testError);
      
      // Get queue statistics
      const stats = await jobQueue.getQueueStats();
      
      // Should return error info
      expect(stats).toHaveProperty('isActive', true);
      expect(stats).toHaveProperty('stats', null);
      expect(stats).toHaveProperty('error', 'Test error');
      
      // Restore original method
      queue.getJobCounts = originalGetJobCounts;
    });
  });
}); 