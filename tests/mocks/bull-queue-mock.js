/**
 * Bull queue mock for testing
 */

// In-memory storage for job queues
const queueData = {
  jobs: new Map(),
  jobsByStatus: {
    waiting: new Set(),
    active: new Set(),
    completed: new Set(),
    failed: new Set(),
    delayed: new Set()
  },
  eventHandlers: {
    error: [],
    completed: [],
    failed: [],
    stalled: []
  },
  nextJobId: 1,
  processors: []
};

class JobMock {
  constructor(id, data, opts = {}) {
    this.id = id;
    this.data = data;
    this.opts = opts;
    this.status = 'waiting';
    this.progress = jest.fn();
    this.timestamp = Date.now();
    this.attempts = 0;
    this.maxAttempts = opts.attempts || 1;
    this.delay = 0;
    this.result = null;
    this.error = null;
  }
  
  // Process this job
  async process() {
    if (queueData.processors.length === 0) {
      throw new Error('No processor registered for queue');
    }
    
    try {
      // Move to active state
      this.status = 'active';
      queueData.jobsByStatus.waiting.delete(this.id);
      queueData.jobsByStatus.active.add(this.id);
      
      // Run the processor function
      this.attempts++;
      this.result = await queueData.processors[0](this);
      
      // Mark as completed
      this.status = 'completed';
      queueData.jobsByStatus.active.delete(this.id);
      queueData.jobsByStatus.completed.add(this.id);
      
      // Trigger completed event
      queueData.eventHandlers.completed.forEach(handler => {
        handler(this);
      });
      
      return this.result;
    } catch (error) {
      // Mark as failed
      this.error = error;
      
      // If we have attempts left, requeue
      if (this.attempts < this.maxAttempts) {
        this.status = 'waiting';
        queueData.jobsByStatus.active.delete(this.id);
        queueData.jobsByStatus.waiting.add(this.id);
        
        // Calculate backoff
        if (this.opts.backoff) {
          const delay = this.opts.backoff.type === 'exponential'
            ? this.opts.backoff.delay * Math.pow(2, this.attempts - 1)
            : this.opts.backoff.delay;
          
          this.delay = delay;
          setTimeout(() => this.process(), delay);
        } else {
          // Immediate retry
          return this.process();
        }
      } else {
        // Out of retries, mark as failed
        this.status = 'failed';
        queueData.jobsByStatus.active.delete(this.id);
        queueData.jobsByStatus.failed.add(this.id);
        
        // Trigger failed event
        queueData.eventHandlers.failed.forEach(handler => {
          handler(this, error);
        });
        
        throw error;
      }
    }
  }
}

// Mock for Bull queue
class QueueMock {
  constructor(name, redisUrl) {
    this.name = name;
    this.redisUrl = redisUrl;
    
    // Reset the queue data
    queueData.jobs.clear();
    Object.keys(queueData.jobsByStatus).forEach(status => {
      queueData.jobsByStatus[status].clear();
    });
    queueData.nextJobId = 1;
    queueData.processors = [];
    
    // Set up event handlers
    this.on = jest.fn((event, handler) => {
      if (queueData.eventHandlers[event]) {
        queueData.eventHandlers[event].push(handler);
      }
      return this;
    });
  }
  
  // Add a job to the queue
  add = jest.fn(async (data, opts = {}) => {
    const jobId = queueData.nextJobId++;
    const job = new JobMock(jobId, data, opts);
    
    queueData.jobs.set(jobId, job);
    queueData.jobsByStatus.waiting.add(jobId);
    
    // If the job has a delay, move it to delayed
    if (opts.delay) {
      job.status = 'delayed';
      queueData.jobsByStatus.waiting.delete(jobId);
      queueData.jobsByStatus.delayed.add(jobId);
      
      // Schedule processing after delay
      setTimeout(() => {
        job.status = 'waiting';
        queueData.jobsByStatus.delayed.delete(jobId);
        queueData.jobsByStatus.waiting.add(jobId);
        
        // Process the job if we have processors
        if (queueData.processors.length > 0) {
          job.process();
        }
      }, opts.delay);
    } else {
      // Process immediately if we have processors
      if (queueData.processors.length > 0) {
        job.process();
      }
    }
    
    return job;
  });
  
  // Register a job processor
  process = jest.fn((concurrency, processor) => {
    // Handle both forms of the process call
    if (typeof concurrency === 'function') {
      processor = concurrency;
      concurrency = 1;
    }
    
    queueData.processors.push(processor);
    
    // Process any waiting jobs
    [...queueData.jobsByStatus.waiting].forEach(jobId => {
      const job = queueData.jobs.get(jobId);
      if (job) {
        job.process();
      }
    });
  });
  
  // Get counts of jobs by status
  getJobCounts = jest.fn(async () => {
    return {
      waiting: queueData.jobsByStatus.waiting.size,
      active: queueData.jobsByStatus.active.size,
      completed: queueData.jobsByStatus.completed.size,
      failed: queueData.jobsByStatus.failed.size,
      delayed: queueData.jobsByStatus.delayed.size
    };
  });
  
  // Get waiting jobs
  getWaiting = jest.fn(async () => {
    return [...queueData.jobsByStatus.waiting].map(id => queueData.jobs.get(id));
  });
  
  // Get active jobs
  getActive = jest.fn(async () => {
    return [...queueData.jobsByStatus.active].map(id => queueData.jobs.get(id));
  });
  
  // Get completed jobs
  getCompleted = jest.fn(async () => {
    return [...queueData.jobsByStatus.completed].map(id => queueData.jobs.get(id));
  });
  
  // Get failed jobs
  getFailed = jest.fn(async () => {
    return [...queueData.jobsByStatus.failed].map(id => queueData.jobs.get(id));
  });
  
  // Get delayed jobs
  getDelayed = jest.fn(async () => {
    return [...queueData.jobsByStatus.delayed].map(id => queueData.jobs.get(id));
  });
  
  // Get count methods
  getWaitingCount = jest.fn(async () => queueData.jobsByStatus.waiting.size);
  getActiveCount = jest.fn(async () => queueData.jobsByStatus.active.size);
  getCompletedCount = jest.fn(async () => queueData.jobsByStatus.completed.size);
  getFailedCount = jest.fn(async () => queueData.jobsByStatus.failed.size);
  getDelayedCount = jest.fn(async () => queueData.jobsByStatus.delayed.size);
  
  // Close the queue
  close = jest.fn(async () => {
    // Reset all data
    queueData.jobs.clear();
    Object.keys(queueData.jobsByStatus).forEach(status => {
      queueData.jobsByStatus[status].clear();
    });
    queueData.processors = [];
    Object.keys(queueData.eventHandlers).forEach(event => {
      queueData.eventHandlers[event] = [];
    });
    
    return true;
  });
}

module.exports = QueueMock; 