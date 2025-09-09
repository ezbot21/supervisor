#!/usr/bin/env node

/**
 * Supervisor.js - Claude CLI Process Manager
 * 
 * Fire-and-forget supervisor for managing Claude CLI execution with stream hang detection.
 * Pre-installed in Daytona snapshots, activated per command, exits when complete.
 * 
 * Architecture: One supervisor per Claude command - spawn, monitor, exit
 * Integration: Triggered by SessionManager DO via Daytona API
 */

const http = require('http');
const { spawn } = require('child_process');
const url = require('url');

// ========================================
// CONFIGURATION & CONSTANTS
// ========================================

const CONFIG = {
  // Stream hang detection
  STREAM_TIMEOUT_MS: 300_000,        // 5 minutes (300,000ms)
  HANG_CHECK_INTERVAL_MS: 5_000,     // Check every 5 seconds
  
  // Restart policy
  MAX_RESTARTS: 3,                   // Maximum restart attempts
  RESTART_DELAY_MS: 2_000,           // 2 second delay between restarts
  RESTART_WINDOW_MS: 3_600_000,      // 1 hour restart window
  
  // HTTP server
  HEALTH_PORT: 3000,                 // Health endpoint port
  HEALTH_TIMEOUT_MS: 5_000,          // Health check timeout
  
  // Claude CLI
  CLAUDE_WORKSPACE: '/workspace/vite-react-web', // Pre-installed template directory
  CLAUDE_CONTINUE_FLAG: '--continue', // Context preservation
  
  // Process management
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: 10_000, // 10 seconds for graceful shutdown
  SIGKILL_DELAY_MS: 5_000,           // 5 seconds before SIGKILL
};

// ========================================
// STRUCTURED LOGGING (PRODUCTION)
// ========================================

class Logger {
  constructor() {
    this.logLevel = process.env.LOG_LEVEL || 'info';
    this.logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
  }

  shouldLog(level) {
    return this.logLevels[level] >= this.logLevels[this.logLevel];
  }

  log(level, message, meta = {}) {
    if (!this.shouldLog(level)) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: 'supervisor',
      sessionId: supervisorState?.sessionId || 'unknown',
      pid: process.pid,
      ...meta
    };

    console.log(JSON.stringify(logEntry));
  }

  debug(message, meta) { this.log('debug', message, meta); }
  info(message, meta) { this.log('info', message, meta); }
  warn(message, meta) { this.log('warn', message, meta); }
  error(message, meta) { this.log('error', message, meta); }
}

const logger = new Logger();

// ========================================
// GLOBAL STATE MANAGEMENT
// ========================================

let supervisorState = {
  // Process management
  claudeProcess: null,
  httpServer: null,
  startTime: Date.now(),
  
  // Stream monitoring
  lastOutputTs: Date.now(),
  lastOutputLine: '',
  streamActive: false,
  
  // Restart management
  restartCount: 0,
  restartTimestamps: [],
  
  // Session correlation
  sessionId: process.env.SESSION_ID || 'unknown',
  claudeCommand: process.argv[2] || '',
  
  // Shutdown coordination
  shuttingDown: false,
  exitCode: null,
  hangDetectionInterval: null
};

// ========================================
// HTTP HEALTH SERVER
// ========================================

// HTTP request handler
function handleHealthRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  logger.debug('Health check received', { method: req.method, path: parsedUrl.pathname, remoteAddress: req.socket.remoteAddress });
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Allow': 'GET' });
    res.end('Method Not Allowed');
    return;
  }
  
  if (parsedUrl.pathname === '/health') {
    const currentTime = Date.now();
    const silenceDuration = currentTime - supervisorState.lastOutputTs;
    const uptime = currentTime - supervisorState.startTime;
    
    const healthData = {
      // Process status
      pid: supervisorState.claudeProcess?.pid || null,
      running: !!(supervisorState.claudeProcess && !supervisorState.claudeProcess.killed),
      uptime: uptime,
      startTime: supervisorState.startTime,
      
      // Stream monitoring
      lastOutputTs: supervisorState.lastOutputTs,
      lastOutputLine: supervisorState.lastOutputLine,
      streamActive: supervisorState.streamActive,
      silenceDuration: silenceDuration,
      streamTimeoutMs: CONFIG.STREAM_TIMEOUT_MS,
      
      // Restart management
      restartCount: supervisorState.restartCount,
      maxRestarts: CONFIG.MAX_RESTARTS,
      restartHistory: supervisorState.restartTimestamps,
      
      // Session correlation
      sessionId: supervisorState.sessionId,
      claudeCommand: supervisorState.claudeCommand,
      
      // System info
      preInstalled: true,
      version: '1.0.0',
      configuredFor: 'fire-and-forget-execution'
    };
    
    logger.info('Health status requested', {
      running: healthData.running,
      silenceDurationSeconds: Math.floor(silenceDuration / 1000),
      restartCount: healthData.restartCount
    });
    
    res.writeHead(200);
    res.end(JSON.stringify(healthData, null, 2));
    
  } else if (parsedUrl.pathname === '/debug') {
    const debugData = {
      // Safe supervisorState properties only (excluding circular references)
      startTime: supervisorState.startTime,
      lastOutputTs: supervisorState.lastOutputTs,
      lastOutputLine: supervisorState.lastOutputLine,
      streamActive: supervisorState.streamActive,
      restartCount: supervisorState.restartCount,
      restartTimestamps: supervisorState.restartTimestamps,
      sessionId: supervisorState.sessionId,
      claudeCommand: supervisorState.claudeCommand,
      shuttingDown: supervisorState.shuttingDown,
      exitCode: supervisorState.exitCode,
      hangDetectionActive: !!supervisorState.hangDetectionInterval,
      
      config: CONFIG,
      environment: {
        NODE_VERSION: process.version,
        PLATFORM: process.platform,
        MEMORY_USAGE: process.memoryUsage(),
        CWD: process.cwd()
      },
      claudeProcess: supervisorState.claudeProcess ? {
        pid: supervisorState.claudeProcess.pid,
        killed: supervisorState.claudeProcess.killed,
        exitCode: supervisorState.claudeProcess.exitCode,
        signalCode: supervisorState.claudeProcess.signalCode
      } : null
    };
    
    res.writeHead(200);
    res.end(JSON.stringify(debugData, null, 2));
    
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// Start HTTP server
function startHealthServer() {
  return new Promise((resolve, reject) => {
    supervisorState.httpServer = http.createServer(handleHealthRequest);
    
    supervisorState.httpServer.listen(CONFIG.HEALTH_PORT, '0.0.0.0', (err) => {
      if (err) {
        logger.error('Failed to start health server', { error: err.message });
        reject(err);
      } else {
        logger.info('Health server started', { port: CONFIG.HEALTH_PORT, endpoints: ['/health', '/debug'] });
        resolve();
      }
    });
    
    supervisorState.httpServer.on('error', (err) => {
      logger.error('Health server error', { error: err.message });
      reject(err);
    });
  });
}

// ========================================
// CLAUDE CLI PROCESS MANAGEMENT
// ========================================

function spawnClaudeProcess() {
  if (supervisorState.shuttingDown) {
    logger.warn('Shutdown in progress - not spawning Claude process');
    return;
  }
  
  const attemptNumber = supervisorState.restartCount + 1;
  logger.info('Spawning Claude CLI process', { 
    attempt: attemptNumber, 
    maxAttempts: CONFIG.MAX_RESTARTS + 1,
    command: supervisorState.claudeCommand,
    workingDirectory: CONFIG.CLAUDE_WORKSPACE 
  });
  
  // Build Claude CLI arguments
  const claudeArgs = [
    CONFIG.CLAUDE_CONTINUE_FLAG,  // Preserve conversation context
    '-p',                         // Prompt flag
    supervisorState.claudeCommand // User command
  ];
  
  // Spawn Claude CLI process
  supervisorState.claudeProcess = spawn('claude', claudeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: CONFIG.CLAUDE_WORKSPACE,
    env: {
      ...process.env,
      SESSION_ID: supervisorState.sessionId,
      SUPERVISOR_PID: process.pid
    }
  });
  
  const pid = supervisorState.claudeProcess.pid;
  logger.info('Claude process started', { claudePid: pid });
  
  // Reset stream monitoring state
  supervisorState.lastOutputTs = Date.now();
  supervisorState.streamActive = true;
  
  // Setup stream monitoring
  setupStreamMonitoring();
  
  // Setup process event handlers
  setupProcessHandlers();
}

function setupStreamMonitoring() {
  const claudeProcess = supervisorState.claudeProcess;
  
  // Monitor STDOUT stream
  claudeProcess.stdout.on('data', (data) => {
    const output = data.toString();
    logger.debug('Claude stdout', { output: output.trim() });
    
    // Update stream activity
    supervisorState.lastOutputTs = Date.now();
    supervisorState.lastOutputLine = output.trim().slice(-100); // Last 100 chars
    supervisorState.streamActive = true;
  });
  
  // Monitor STDERR stream  
  claudeProcess.stderr.on('data', (data) => {
    const output = data.toString();
    logger.warn('Claude stderr', { output: output.trim() });
    
    // Update stream activity (errors are still activity)
    supervisorState.lastOutputTs = Date.now();
    supervisorState.lastOutputLine = output.trim().slice(-100);
    supervisorState.streamActive = true;
  });
}

function setupProcessHandlers() {
  const claudeProcess = supervisorState.claudeProcess;
  
  claudeProcess.on('exit', (code, signal) => {
    logger.info('Claude process exited', { exitCode: code, signal, claudePid: claudeProcess.pid });
    
    supervisorState.streamActive = false;
    
    if (supervisorState.shuttingDown) {
      logger.warn('Shutdown in progress - not handling exit');
      return;
    }
    
    if (code === 0) {
      // ✅ SUCCESS - Claude completed successfully
      logger.info('Claude command completed successfully');
      gracefulShutdown(0, 'Claude completed successfully');
    } else {
      // ❌ ERROR - Claude failed or was killed
      logger.error('Claude process failed', { exitCode: code, signal });
      handleClaudeFailure(code, signal);
    }
  });
  
  claudeProcess.on('error', (error) => {
    logger.error('Claude process error', { error: error.message });
    handleClaudeFailure(-1, 'ERROR');
  });
}

// ========================================
// STREAM HANG DETECTION & RESTART LOGIC
// ========================================

// Start hang detection monitoring
function startHangDetection() {
  supervisorState.hangDetectionInterval = setInterval(() => {
    if (supervisorState.shuttingDown) {
      clearInterval(supervisorState.hangDetectionInterval);
      return;
    }
    
    if (!supervisorState.claudeProcess || supervisorState.claudeProcess.killed) {
      return; // No active process to monitor
    }
    
    const currentTime = Date.now();
    const silenceDuration = currentTime - supervisorState.lastOutputTs;
    const remainingTime = CONFIG.STREAM_TIMEOUT_MS - silenceDuration;
    
    if (silenceDuration > CONFIG.STREAM_TIMEOUT_MS) {
      // 🚨 HANG DETECTED
      logger.error('Stream hang detected', {
        silenceDurationSeconds: Math.floor(silenceDuration / 1000),
        timeoutThresholdSeconds: Math.floor(CONFIG.STREAM_TIMEOUT_MS / 1000),
        claudePid: supervisorState.claudeProcess.pid
      });
      
      // Kill the hanging process
      killHangingProcess();
      
      clearInterval(supervisorState.hangDetectionInterval);
    } else {
      // ✅ Stream healthy
      const remainingSeconds = Math.floor(remainingTime / 1000);
      logger.debug('Stream healthy', { remainingTimeoutSeconds: remainingSeconds, claudePid: supervisorState.claudeProcess.pid });
    }
  }, CONFIG.HANG_CHECK_INTERVAL_MS);
}

function killHangingProcess() {
  if (!supervisorState.claudeProcess || supervisorState.claudeProcess.killed) {
    logger.warn('No active process to kill');
    return;
  }
  
  const pid = supervisorState.claudeProcess.pid;
  logger.warn('Killing hanging Claude process', { claudePid: pid });
  
  try {
    // First attempt: SIGTERM (graceful)
    supervisorState.claudeProcess.kill('SIGTERM');
    
    // Fallback: SIGKILL after delay
    setTimeout(() => {
      if (supervisorState.claudeProcess && !supervisorState.claudeProcess.killed) {
        logger.error('Force killing with SIGKILL', { claudePid: pid });
        supervisorState.claudeProcess.kill('SIGKILL');
      }
    }, CONFIG.SIGKILL_DELAY_MS);
    
  } catch (error) {
    logger.error('Failed to kill process', { error: error.message });
  }
  
  // The 'exit' event handler will handle restart logic
}

function handleClaudeFailure(exitCode, signal) {
  if (supervisorState.shuttingDown) return;
  
  logger.warn('Handling Claude failure', { exitCode, signal });
  
  // Check if we can restart
  if (canAttemptRestart()) {
    scheduleRestart();
  } else {
    logger.error('Max restarts reached or restart window exceeded');
    gracefulShutdown(1, `Claude failed after ${supervisorState.restartCount} restarts`);
  }
}

function canAttemptRestart() {
  const now = Date.now();
  
  // Check restart count limit
  if (supervisorState.restartCount >= CONFIG.MAX_RESTARTS) {
    logger.error('Restart count limit reached', { restartCount: supervisorState.restartCount, maxRestarts: CONFIG.MAX_RESTARTS });
    return false;
  }
  
  // Check restart time window (prevent rapid restart loops)
  const recentRestarts = supervisorState.restartTimestamps.filter(
    timestamp => (now - timestamp) < CONFIG.RESTART_WINDOW_MS
  );
  
  if (recentRestarts.length >= CONFIG.MAX_RESTARTS) {
    logger.error('Too many restarts in time window', { recentRestarts: recentRestarts.length, windowHours: 1 });
    return false;
  }
  
  return true;
}

function scheduleRestart() {
  const attemptNumber = supervisorState.restartCount + 1;
  logger.info('Scheduling restart attempt', { attempt: attemptNumber, maxAttempts: CONFIG.MAX_RESTARTS + 1, delayMs: CONFIG.RESTART_DELAY_MS });
  
  setTimeout(() => {
    if (supervisorState.shuttingDown) {
      logger.warn('Shutdown initiated - canceling restart');
      return;
    }
    
    // Record restart attempt
    supervisorState.restartCount++;
    supervisorState.restartTimestamps.push(Date.now());
    
    logger.info('Attempting restart', { restartCount: supervisorState.restartCount, maxAttempts: CONFIG.MAX_RESTARTS + 1 });
    spawnClaudeProcess();
    
    // Restart hang detection
    startHangDetection();
    
  }, CONFIG.RESTART_DELAY_MS);
}

// ========================================
// GRACEFUL SHUTDOWN
// ========================================

function gracefulShutdown(exitCode, reason) {
  if (supervisorState.shuttingDown) {
    logger.warn('Shutdown already in progress');
    return;
  }
  
  supervisorState.shuttingDown = true;
  supervisorState.exitCode = exitCode;
  
  logger.info('Graceful shutdown initiated', {
    exitCode,
    reason,
    sessionId: supervisorState.sessionId,
    uptimeSeconds: Math.floor((Date.now() - supervisorState.startTime) / 1000)
  });
  
  const cleanupTasks = [];
  
  // 1. Stop hang detection
  if (supervisorState.hangDetectionInterval) {
    clearInterval(supervisorState.hangDetectionInterval);
    logger.info('Hang detection stopped');
  }
  
  // 2. Stop HTTP server
  if (supervisorState.httpServer) {
    cleanupTasks.push(new Promise((resolve) => {
      supervisorState.httpServer.close((err) => {
        if (err) {
          logger.error('Error stopping HTTP server', { error: err.message });
        } else {
          logger.info('HTTP server stopped');
        }
        resolve();
      });
    }));
  }
  
  // 3. Terminate Claude process
  if (supervisorState.claudeProcess && !supervisorState.claudeProcess.killed) {
    cleanupTasks.push(new Promise((resolve) => {
      const pid = supervisorState.claudeProcess.pid;
      logger.info('Terminating Claude process', { claudePid: pid });
      
      const forceKillTimer = setTimeout(() => {
        if (!supervisorState.claudeProcess.killed) {
          logger.warn('Force killing Claude process', { claudePid: pid });
          supervisorState.claudeProcess.kill('SIGKILL');
        }
        resolve();
      }, CONFIG.SIGKILL_DELAY_MS);
      
      supervisorState.claudeProcess.on('exit', () => {
        clearTimeout(forceKillTimer);
        logger.info('Claude process terminated', { claudePid: pid });
        resolve();
      });
      
      supervisorState.claudeProcess.kill('SIGTERM');
    }));
  }
  
  // Execute cleanup with timeout
  Promise.allSettled(cleanupTasks).then(() => {
    logger.info('All cleanup tasks completed');
    finalExit(exitCode, reason);
  });
  
  // Fallback timeout for cleanup
  setTimeout(() => {
    logger.warn('Cleanup timeout reached - forcing exit');
    finalExit(exitCode, reason);
  }, CONFIG.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
}

function finalExit(exitCode, reason) {
  logger.info('Supervisor final exit', {
    exitCode,
    reason,
    totalRestarts: supervisorState.restartCount,
    sessionId: supervisorState.sessionId,
    command: supervisorState.claudeCommand
  });
  
  process.exit(exitCode);
}

// ========================================
// SUPERVISOR INITIALIZATION
// ========================================

async function initializeSupervisor() {
  logger.info('Supervisor initializing', {
    sessionId: supervisorState.sessionId,
    command: supervisorState.claudeCommand,
    pid: process.pid,
    workingDirectory: CONFIG.CLAUDE_WORKSPACE,
    configuration: 'Fire-and-Forget Execution'
  });
  
  // Validate environment
  if (!supervisorState.sessionId || supervisorState.sessionId === 'unknown') {
    logger.error('No SESSION_ID provided');
    process.exit(1);
  }
  
  if (!supervisorState.claudeCommand) {
    logger.error('No Claude command provided');
    process.exit(1);
  }
  
  try {
    // 1. Start HTTP health server
    logger.info('Starting health server');
    await startHealthServer();
    
    // 2. Start hang detection monitoring
    logger.info('Starting hang detection');
    startHangDetection();
    
    // 3. Spawn Claude CLI process
    logger.info('Spawning Claude CLI process');
    spawnClaudeProcess();
    
    logger.info('Supervisor fully initialized', { healthEndpoint: `http://localhost:${CONFIG.HEALTH_PORT}/health` });
    
  } catch (error) {
    logger.error('Supervisor initialization failed', { error: error.message });
    process.exit(1);
  }
}

// ========================================
// PROCESS SIGNAL HANDLERS
// ========================================

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM');
  gracefulShutdown(0, 'SIGTERM received');
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT');
  gracefulShutdown(0, 'SIGINT received');
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  gracefulShutdown(1, `Uncaught exception: ${error.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason: reason?.message || reason });
  gracefulShutdown(1, `Unhandled rejection: ${reason}`);
});

// ========================================
// MAIN EXECUTION
// ========================================

// Start the supervisor if run directly
if (require.main === module) {
  initializeSupervisor().catch(error => {
    logger.error('Failed to initialize supervisor', { error: error.message });
    process.exit(1);
  });
}

// Export for testing
module.exports = {
  CONFIG,
  supervisorState,
  gracefulShutdown
};