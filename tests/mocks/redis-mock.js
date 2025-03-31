/**
 * Redis mock for testing
 */

// In-memory data store for Redis mock
const dataStore = new Map();
const pubsubChannels = new Map();
const expiries = new Map();

// Basic Redis mock implementation
const redisMock = {
  // Basic operations
  set: jest.fn((key, value, ...args) => {
    dataStore.set(key, value);
    
    // Handle expiry if EX option is provided
    if (args.length >= 2 && args[0] === 'EX') {
      const expiry = parseInt(args[1]);
      if (!isNaN(expiry)) {
        expiries.set(key, Date.now() + (expiry * 1000));
      }
    }
    
    return Promise.resolve('OK');
  }),
  
  get: jest.fn((key) => {
    // Check if key has expired
    if (expiries.has(key) && Date.now() > expiries.get(key)) {
      dataStore.delete(key);
      expiries.delete(key);
      return Promise.resolve(null);
    }
    
    return Promise.resolve(dataStore.get(key) || null);
  }),
  
  del: jest.fn((key) => {
    const existed = dataStore.has(key);
    dataStore.delete(key);
    expiries.delete(key);
    return Promise.resolve(existed ? 1 : 0);
  }),
  
  // Pub/Sub operations
  publish: jest.fn((channel, message) => {
    if (pubsubChannels.has(channel)) {
      pubsubChannels.get(channel).forEach(callback => {
        callback(message);
      });
    }
    return Promise.resolve(pubsubChannels.has(channel) ? pubsubChannels.get(channel).size : 0);
  }),
  
  subscribe: jest.fn((channel, callback) => {
    if (!pubsubChannels.has(channel)) {
      pubsubChannels.set(channel, new Set());
    }
    pubsubChannels.get(channel).add(callback);
    return Promise.resolve();
  }),
  
  unsubscribe: jest.fn((channel, callback) => {
    if (pubsubChannels.has(channel) && callback) {
      pubsubChannels.get(channel).delete(callback);
    } else if (pubsubChannels.has(channel)) {
      pubsubChannels.delete(channel);
    }
    return Promise.resolve();
  }),
  
  // Health checks
  ping: jest.fn(() => Promise.resolve('PONG')),
  
  // Utility to clear all data (for test reset)
  flushall: jest.fn(() => {
    dataStore.clear();
    pubsubChannels.clear();
    expiries.clear();
    return Promise.resolve('OK');
  }),
  
  // Reset all mocks
  _reset: () => {
    dataStore.clear();
    pubsubChannels.clear();
    expiries.clear();
    
    // Reset all mocked functions
    Object.values(redisMock)
      .filter(val => typeof val === 'function' && val.mockReset)
      .forEach(mockFn => mockFn.mockReset());
  },
  
  // Connection management
  quit: jest.fn(() => Promise.resolve('OK')),
  
  // Add other needed Redis methods as mock functions
  incr: jest.fn((key) => {
    const value = parseInt(dataStore.get(key) || '0');
    const newValue = value + 1;
    dataStore.set(key, newValue.toString());
    return Promise.resolve(newValue);
  }),
  
  exists: jest.fn((key) => {
    return Promise.resolve(dataStore.has(key) ? 1 : 0);
  }),
  
  expire: jest.fn((key, seconds) => {
    if (dataStore.has(key)) {
      expiries.set(key, Date.now() + (seconds * 1000));
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }),
  
  keys: jest.fn((pattern) => {
    // Simple pattern matching (this is not full Redis pattern support)
    const keys = [...dataStore.keys()];
    if (pattern === '*') {
      return Promise.resolve(keys);
    }
    
    // Very basic wildcard support
    const regex = new RegExp(pattern.replace('*', '.*'));
    return Promise.resolve(keys.filter(key => regex.test(key)));
  })
};

module.exports = redisMock; 