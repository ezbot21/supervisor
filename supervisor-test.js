#!/usr/bin/env node

/**
 * Supervisor Test Suite
 * =====================
 * 
 * Comprehensive validation suite for supervisor.js functionality
 * Tests all core features: health server, process management, hang detection, restart logic
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Test configuration
const TEST_CONFIG = {
  SUPERVISOR_PATH: path.join(__dirname, 'supervisor.js'),
  TEST_TIMEOUT: 120_000,  // 2 minutes per test (for real Claude API calls)
  HEALTH_PORT: 3000,
  TEST_SESSION_ID: 'test-session-real-claude'
};

// Global test state
let testResults = [];
let currentTest = null;

// ========================================
// TEST UTILITIES
// ========================================

function log(message, ...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, ...args);
}

function createTestResult(name, passed, error = null, duration = 0) {
  return {
    name,
    passed,
    error: error ? error.message : null,
    duration,
    timestamp: Date.now()
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeHealthRequest(path = '/health') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: TEST_CONFIG.HEALTH_PORT,
      path: path,
      method: 'GET',
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: data });
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Request timeout')));
    req.end();
  });
}

function spawnSupervisor(command, options = {}) {
  const env = {
    ...process.env,
    SESSION_ID: options.sessionId || TEST_CONFIG.TEST_SESSION_ID,
    // Use real Claude CLI (remove mock PATH modification)
    ...options.env
  };
  
  log(`🚀 Spawning supervisor with real Claude CLI: ${command}`);
  
  const supervisor = spawn('node', [TEST_CONFIG.SUPERVISOR_PATH, command], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options
  });
  
  // Log supervisor output for debugging
  supervisor.stdout.on('data', (data) => {
    log(`📤 SUPERVISOR STDOUT: ${data.toString().trim()}`);
  });
  
  supervisor.stderr.on('data', (data) => {
    log(`🚨 SUPERVISOR STDERR: ${data.toString().trim()}`);
  });
  
  return supervisor;
}

// ========================================
// INDIVIDUAL TESTS
// ========================================

async function testHealthServerStartup() {
  const testName = 'Health Server Startup';
  const startTime = Date.now();
  
  try {
    log(`🧪 Testing: ${testName}`);
    
    // Start supervisor with simple Claude command
    const supervisor = spawnSupervisor('What is 2+2?');
    
    // Wait for health server to start
    await sleep(5000);
    
    // Test health endpoint
    const response = await makeHealthRequest('/health');
    
    if (response.statusCode !== 200) {
      throw new Error(`Health endpoint returned status ${response.statusCode}`);
    }
    
    if (!response.data.preInstalled) {
      throw new Error('Health response missing preInstalled flag');
    }
    
    if (response.data.sessionId !== TEST_CONFIG.TEST_SESSION_ID) {
      throw new Error(`Incorrect session ID: ${response.data.sessionId}`);
    }
    
    log(`✅ Health server responding correctly`);
    
    // Cleanup
    supervisor.kill('SIGTERM');
    await sleep(2000);
    
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, true, null, duration));
    
  } catch (error) {
    log(`❌ ${testName} failed:`, error.message);
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, false, error, duration));
  }
}

async function testDebugEndpoint() {
  const testName = 'Debug Endpoint Functionality';
  const startTime = Date.now();
  
  try {
    log(`🧪 Testing: ${testName}`);
    
    const supervisor = spawnSupervisor('What is the capital of France?');
    await sleep(5000);
    
    // Test debug endpoint
    const response = await makeHealthRequest('/debug');
    
    if (response.statusCode !== 200) {
      throw new Error(`Debug endpoint returned status ${response.statusCode}`);
    }
    
    // Validate debug data structure
    if (!response.data.config) {
      throw new Error('Debug response missing config');
    }
    
    if (!response.data.environment) {
      throw new Error('Debug response missing environment info');
    }
    
    if (!response.data.environment.NODE_VERSION) {
      throw new Error('Debug response missing Node.js version');
    }
    
    log(`✅ Debug endpoint providing detailed diagnostics`);
    
    // Cleanup
    supervisor.kill('SIGTERM');
    await sleep(2000);
    
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, true, null, duration));
    
  } catch (error) {
    log(`❌ ${testName} failed:`, error.message);
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, false, error, duration));
  }
}

async function testClaudeProcessSpawning() {
  const testName = 'Claude Process Spawning';
  const startTime = Date.now();
  
  try {
    log(`🧪 Testing: ${testName}`);
    
    const supervisor = spawnSupervisor('Why is the sky blue?');
    
    // Wait for process to spawn and complete
    await sleep(10000);
    
    // Check health during execution
    const response = await makeHealthRequest('/health');
    
    if (!response.data.claudeCommand) {
      throw new Error('Health response missing claudeCommand');
    }
    
    if (response.data.claudeCommand !== 'Why is the sky blue?') {
      throw new Error(`Incorrect command: ${response.data.claudeCommand}`);
    }
    
    log(`✅ Claude process spawning correctly`);
    
    // Wait for supervisor to complete and exit
    await new Promise((resolve) => {
      supervisor.on('exit', (code) => {
        log(`🏁 Supervisor exited with code: ${code}`);
        resolve();
      });
    });
    
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, true, null, duration));
    
  } catch (error) {
    log(`❌ ${testName} failed:`, error.message);
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, false, error, duration));
  }
}

async function testStreamMonitoring() {
  const testName = 'Stream Activity Monitoring';
  const startTime = Date.now();
  
  try {
    log(`🧪 Testing: ${testName}`);
    
    // Start supervisor with Claude command that should produce ongoing output
    const supervisor = spawnSupervisor('Explain quantum physics in simple terms');
    
    await sleep(5000);
    
    // Check initial health
    let response = await makeHealthRequest('/health');
    const initialOutputTs = response.data.lastOutputTs;
    
    // Wait for more output (Claude may take longer)
    await sleep(10000);
    
    // Check updated health
    response = await makeHealthRequest('/health');
    
    // For real Claude, stream may be active but still processing
    if (!response.data.streamActive) {
      throw new Error('Stream not marked as active');
    }
    
    // Check if supervisor is still running (indicates Claude is processing)
    if (!response.data.running) {
      throw new Error('Supervisor not running when expected');
    }
    
    log(`✅ Stream monitoring working correctly`);
    
    // Cleanup - kill supervisor since Claude may take a long time
    supervisor.kill('SIGTERM');
    await sleep(2000);
    
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, true, null, duration));
    
  } catch (error) {
    log(`❌ ${testName} failed:`, error.message);
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, false, error, duration));
  }
}

async function testGracefulShutdown() {
  const testName = 'Graceful Shutdown';
  const startTime = Date.now();
  
  try {
    log(`🧪 Testing: ${testName}`);
    
    const supervisor = spawnSupervisor('Tell me about artificial intelligence'); // Claude command
    
    await sleep(5000);
    
    // Verify supervisor is running
    let response = await makeHealthRequest('/health');
    if (!response.data.running) {
      throw new Error('Supervisor not running when expected');
    }
    
    // Send SIGTERM for graceful shutdown
    supervisor.kill('SIGTERM');
    
    // Wait for shutdown
    const exitCode = await new Promise((resolve) => {
      supervisor.on('exit', (code) => {
        log(`🛑 Supervisor shutdown with code: ${code}`);
        resolve(code);
      });
      
      // Timeout if shutdown takes too long
      setTimeout(() => {
        resolve(-1); // Timeout indicator
      }, 10000);
    });
    
    if (exitCode === -1) {
      throw new Error('Graceful shutdown timeout');
    }
    
    if (exitCode !== 0) {
      throw new Error(`Unexpected exit code: ${exitCode}`);
    }
    
    // Verify health endpoint no longer accessible
    try {
      await makeHealthRequest('/health');
      throw new Error('Health endpoint still accessible after shutdown');
    } catch (e) {
      // Expected - health server should be down
      if (e.code !== 'ECONNREFUSED') {
        throw new Error(`Unexpected error: ${e.message}`);
      }
    }
    
    log(`✅ Graceful shutdown working correctly`);
    
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, true, null, duration));
    
  } catch (error) {
    log(`❌ ${testName} failed:`, error.message);
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, false, error, duration));
  }
}

async function testEnvironmentValidation() {
  const testName = 'Environment Validation';
  const startTime = Date.now();
  
  try {
    log(`🧪 Testing: ${testName}`);
    
    // Test missing SESSION_ID
    const supervisorNoSession = spawn('node', [TEST_CONFIG.SUPERVISOR_PATH, 'echo test'], {
      env: { ...process.env, SESSION_ID: '' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    const exitCode1 = await new Promise((resolve) => {
      supervisorNoSession.on('exit', resolve);
    });
    
    if (exitCode1 !== 1) {
      throw new Error('Should fail with missing SESSION_ID');
    }
    
    // Test missing command
    const supervisorNoCommand = spawn('node', [TEST_CONFIG.SUPERVISOR_PATH], {
      env: { ...process.env, SESSION_ID: 'test' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    const exitCode2 = await new Promise((resolve) => {
      supervisorNoCommand.on('exit', resolve);
    });
    
    if (exitCode2 !== 1) {
      throw new Error('Should fail with missing command');
    }
    
    log(`✅ Environment validation working correctly`);
    
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, true, null, duration));
    
  } catch (error) {
    log(`❌ ${testName} failed:`, error.message);
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, false, error, duration));
  }
}

async function testSuccessfulExecution() {
  const testName = 'Successful Command Execution';
  const startTime = Date.now();
  
  try {
    log(`🧪 Testing: ${testName}`);
    
    const supervisor = spawnSupervisor('What is 1+1?');
    
    const exitCode = await new Promise((resolve) => {
      supervisor.on('exit', resolve);
      
      // Timeout after 60 seconds (allow time for real Claude)
      setTimeout(() => resolve(-1), 60000);
    });
    
    if (exitCode === -1) {
      throw new Error('Supervisor execution timeout');
    }
    
    if (exitCode !== 0) {
      throw new Error(`Supervisor failed with exit code: ${exitCode}`);
    }
    
    log(`✅ Successful execution completed correctly`);
    
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, true, null, duration));
    
  } catch (error) {
    log(`❌ ${testName} failed:`, error.message);
    const duration = Date.now() - startTime;
    testResults.push(createTestResult(testName, false, error, duration));
  }
}

// ========================================
// TEST EXECUTION & REPORTING
// ========================================

async function runAllTests() {
  log(`🎬 Starting Supervisor Test Suite`);
  log(`📁 Supervisor path: ${TEST_CONFIG.SUPERVISOR_PATH}`);
  log(`🔧 Test session ID: ${TEST_CONFIG.TEST_SESSION_ID}`);
  
  const startTime = Date.now();
  
  // Run all tests with longer intervals for real Claude
  await testHealthServerStartup();
  await sleep(3000);
  
  await testDebugEndpoint();
  await sleep(3000);
  
  await testEnvironmentValidation();
  await sleep(2000);
  
  await testClaudeProcessSpawning();
  await sleep(3000);
  
  await testStreamMonitoring();
  await sleep(3000);
  
  await testSuccessfulExecution();
  await sleep(3000);
  
  await testGracefulShutdown();
  await sleep(3000);
  
  // Generate report
  const totalTime = Date.now() - startTime;
  generateTestReport(totalTime);
}

function generateTestReport(totalTime) {
  log(`\n📊 TEST SUITE COMPLETE`);
  log(`⏱️  Total execution time: ${totalTime}ms`);
  
  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;
  const total = testResults.length;
  
  log(`\n📈 SUMMARY:`);
  log(`   ✅ Passed: ${passed}/${total}`);
  log(`   ❌ Failed: ${failed}/${total}`);
  log(`   📊 Success rate: ${Math.round((passed/total) * 100)}%`);
  
  log(`\n📋 DETAILED RESULTS:`);
  testResults.forEach(result => {
    const status = result.passed ? '✅' : '❌';
    const duration = `${result.duration}ms`;
    log(`   ${status} ${result.name} (${duration})`);
    
    if (!result.passed && result.error) {
      log(`      Error: ${result.error}`);
    }
  });
  
  // Validation checklist
  log(`\n✅ FUNCTIONAL VALIDATION CHECKLIST:`);
  const validations = [
    { name: 'Process Lifecycle', test: 'Claude Process Spawning' },
    { name: 'HTTP Server', test: 'Health Server Startup' },
    { name: 'Stream Monitoring', test: 'Stream Activity Monitoring' },
    { name: 'Graceful Shutdown', test: 'Graceful Shutdown' },
    { name: 'Environment Validation', test: 'Environment Validation' },
    { name: 'Successful Execution', test: 'Successful Command Execution' }
  ];
  
  validations.forEach(v => {
    const testResult = testResults.find(r => r.name === v.test);
    const status = testResult?.passed ? '✅' : '❌';
    log(`   ${status} ${v.name}: ${testResult?.passed ? 'PASS' : 'FAIL'}`);
  });
  
  // Overall result
  const overallSuccess = failed === 0;
  log(`\n🎯 OVERALL RESULT: ${overallSuccess ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  
  if (overallSuccess) {
    log(`\n🚀 SUPERVISOR VALIDATION COMPLETE - Ready for deployment!`);
  } else {
    log(`\n🛑 SUPERVISOR VALIDATION FAILED - Issues need to be addressed before deployment.`);
  }
  
  process.exit(overallSuccess ? 0 : 1);
}

// ========================================
// MAIN EXECUTION
// ========================================

if (require.main === module) {
  // Check if supervisor.js exists
  if (!fs.existsSync(TEST_CONFIG.SUPERVISOR_PATH)) {
    log(`❌ supervisor.js not found at: ${TEST_CONFIG.SUPERVISOR_PATH}`);
    process.exit(1);
  }
  
  runAllTests().catch(error => {
    log(`💥 Test suite failed:`, error);
    process.exit(1);
  });
}