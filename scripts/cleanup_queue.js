#!/usr/bin/env node

/**
 * Emergency Queue Cleanup Script
 * Clears all jobs from the Redis queue to remove old bulk sync jobs
 */

const db = require('../database');

async function cleanupQueue() {
    console.log('🧹 Starting Emergency Queue Cleanup...');
    console.log('This will remove ALL jobs from the queue (waiting, active, delayed, completed, failed)');
    
    try {
        // Initialize database connection
        console.log('📡 Initializing database connection...');
        const success = await db.initialize();
        if (!success) {
            console.error('❌ Failed to initialize database connection');
            process.exit(1);
        }
        console.log('✅ Database connection established');
        
        // Get queue stats before cleanup
        console.log('📊 Getting queue statistics...');
        const bgStatus = await db.getBackgroundSyncStatus();
        if (!bgStatus.isInitialized) {
            console.log('⚠️ Background sync system not initialized, but that\'s okay for cleanup');
        }
        
        // Perform the cleanup
        console.log('🔥 Clearing all jobs from queue...');
        const result = await db.clearAllJobs();
        
        if (result.success) {
            console.log('✅ Queue cleanup completed successfully!');
            console.log('📈 Before cleanup:', result.before);
            console.log('📉 After cleanup:', result.after);
            
            const clearedJobs = (result.before?.waitingCount || 0) + 
                              (result.before?.activeCount || 0) + 
                              (result.before?.delayedCount || 0);
            console.log(`🗑️ Cleared ${clearedJobs} jobs from the queue`);
        } else {
            console.error('❌ Queue cleanup failed:', result.message);
            if (result.error) {
                console.error('Error details:', result.error);
            }
            process.exit(1);
        }
        
    } catch (error) {
        console.error('💥 Unexpected error during cleanup:', error);
        process.exit(1);
    } finally {
        // Close database connections
        console.log('🔌 Closing database connections...');
        await db.closeConnections();
        console.log('👋 Cleanup script completed');
        process.exit(0);
    }
}

// Handle script arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🧹 Emergency Queue Cleanup Script

Usage: node scripts/cleanup_queue.js [options]

Options:
  --help, -h    Show this help message
  --force, -f   Skip confirmation (for automated scripts)

This script will:
1. Connect to Redis
2. Clear ALL jobs from the queue (waiting, active, delayed, completed, failed)
3. Display before/after statistics
4. Close connections and exit

⚠️ WARNING: This will remove ALL queued jobs, including any currently processing.
Use this only when you need to clear a backlog of old bulk sync jobs.
`);
    process.exit(0);
}

// Check for force flag
const force = args.includes('--force') || args.includes('-f');

if (!force) {
    console.log('⚠️ WARNING: This will clear ALL jobs from the queue!');
    console.log('This includes waiting, active, delayed, completed, and failed jobs.');
    console.log('');
    console.log('Use --force flag to skip this confirmation in scripts.');
    console.log('Press Ctrl+C to cancel or wait 5 seconds to continue...');
    
    setTimeout(() => {
        cleanupQueue();
    }, 5000);
} else {
    cleanupQueue();
} 