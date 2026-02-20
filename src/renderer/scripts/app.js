/**
 * Renderer script for file transfer functionality
 * Uses Electron IPC for real file transfer operations
 * Optimized and cleaned version
 */

// ============================================================================
// DEBUG & LOGGING
// ============================================================================

const DEBUG = true; // Set to true for debug logs
const debug = {
  log: (...args) => DEBUG && console.log(...args),
  warn: (...args) => DEBUG && console.warn(...args),
  error: console.error.bind(console), // Always log errors
};

// ============================================================================
// INITIALIZATION & DOM ELEMENTS
// ============================================================================

// Check if electronAPI is available
if (!window.electronAPI) {
  debug.error('Electron API not available!');
  showAlert({
    title: 'Application Error',
    message: 'Electron API not loaded. Please restart the application.',
    confirm: false,
  });
}

// Modal elements
const modals = {
  help: document.getElementById('help-modal'),
  mode: document.getElementById('mode-modal'),
  sender: document.getElementById('sender-modal'),
  receiver: document.getElementById('receiver-modal'),
};

// Button elements
const buttons = {
  localTransfer: document.getElementById('local-transfer-button'),
  remoteTransfer: document.getElementById('remote-transfer-button'),
  secureTransfer: document.getElementById('secure-transfer-button'),
  help: document.getElementById('help-button'),
  senderMode: document.getElementById('sender-mode'),
  receiverMode: document.getElementById('receiver-mode'),
  connect: document.getElementById('connect-btn'),
  sendFiles: document.getElementById('send-files-btn'),
  browseFolder: document.getElementById('browse-folder-btn'),
  refreshSenders: document.getElementById('refresh-senders-btn'),
  backToList: document.getElementById('back-to-list-btn'),
  autoDiscover: document.getElementById('auto-discover-btn'),
  manualConnect: document.getElementById('manual-connect-btn'),
  manualProceed: document.getElementById('manual-proceed-btn'),
  toggleManualDetails: document.getElementById('toggle-manual-details'),
};

// Input elements
const inputs = {
  fileDropZone: document.getElementById('file-drop-zone'),
  saveLocation: document.getElementById('save-location'),
  receiverCode: document.getElementById('receiver-code-input'),
  manualIp: document.getElementById('manual-ip-input'),
  manualPort: document.getElementById('manual-port-input'),
};

// ============================================================================
// GLOBAL STATE
// ============================================================================

const state = {
  selectedFilePaths: [],
  saveDirectory: '',
  currentMode: null, // 'sender' or 'receiver'
  isConnected: false,
  transferType: null, // 'local', 'remote', or 'secure'
  isTransferring: false,
  remotePeer: null,
  remoteConnection: null,
  discoveredSenders: [],
  selectedSender: null,
  localTransferState: {}, // Track timing for local transfers
};

// Load saved path from localStorage
try {
  const savedPath = localStorage.getItem('lastSavePath');
  if (savedPath) state.saveDirectory = savedPath;
} catch (e) {
  debug.warn('Could not load saved path:', e);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Convert Uint8Array to base64 without stack overflow
 * Processes in chunks to avoid spreading large arrays
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192; // Process 8KB at a time
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }

  return btoa(binary);
}

/**
 * Convert base64 to Uint8Array safely
 */
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Merge multiple Uint8Array buffers into a single buffer
 */
function mergeBuffers(buffers) {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

function savePath(path) {
  try {
    localStorage.setItem('lastSavePath', path);
    state.saveDirectory = path;
  } catch (e) {
    debug.warn('Could not save path to localStorage:', e);
  }
}

function updateUIElement(id, property, value) {
  const element = document.getElementById(id);
  if (element) {
    if (property === 'text') {
      element.textContent = value;
    } else if (property === 'display') {
      element.style.display = value;
    } else if (property === 'value') {
      element.value = value;
    } else {
      element[property] = value;
    }
  }
}

function isValidIP(ip) {
  const ipRegex =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
  return ipRegex.test(ip);
}

function isValidPort(port) {
  const num = Number(port);
  return Number.isInteger(num) && num >= 0 && num <= 65535;
}

// ============================================================================
// CLEANUP & RESET FUNCTIONS
// ============================================================================

function sendDisconnectNotification(reason = 'User closed the connection') {
  if (state.remoteConnection && state.remoteConnection.open) {
    try {
      debug.log('Sending disconnect notification:', reason);
      state.remoteConnection.send({
        type: 'disconnect-request',
        reason,
        mode: state.currentMode,
        timestamp: Date.now(),
      });
    } catch (error) {
      debug.error('Failed to send disconnect notification:', error);
    }
  }
}

async function cleanupConnection() {
  try {
    debug.log('Cleanup:', state.currentMode, state.transferType);

    // Send disconnect notification for remote connections before closing
    if (state.transferType === 'remote' && state.remoteConnection) {
      sendDisconnectNotification('User closed the connection');
      // Give a brief moment for the message to be sent
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Cleanup remote peer connections (renderer-side PeerJS)
    if (state.remoteConnection) {
      state.remoteConnection.close();
      state.remoteConnection = null;
    }
    if (state.remotePeer) {
      state.remotePeer.destroy();
      state.remotePeer = null;
    }

    // Cleanup backend connections
    if (state.currentMode === 'sender') {
      await window.electronAPI.stopSender(state.transferType);
    } else if (state.currentMode === 'receiver') {
      await window.electronAPI.disconnectReceiver();
    }

    // Reset state (but keep cached save path)
    state.isConnected = false;
    state.currentMode = null;
    state.selectedFilePaths = [];
    state.transferType = null;
  } catch (error) {
    debug.error('Error during cleanup:', error);
  }
}

function resetConnectionUI(mode) {
  state.isTransferring = false;

  if (mode === 'sender') {
    resetSenderUI();
  } else if (mode === 'receiver') {
    resetReceiverUI();
  }
}

function resetSenderUI() {
  // Close the sender modal
  if (modals.sender) {
    modals.sender.style.display = 'none';
  }

  updateUIElement('sender-setup', 'display', 'block');
  updateUIElement('sender-transfer', 'display', 'none');

  const fileList = document.getElementById('file-list');
  if (fileList) fileList.innerHTML = '';

  document.querySelectorAll('.file-remove').forEach((el) => (el.style.display = 'inline'));

  if (buttons.sendFiles) {
    buttons.sendFiles.style.display = 'none';
    buttons.sendFiles.disabled = false;
    buttons.sendFiles.textContent = '🚀 Send Files';
  }

  const statusMsg = document.querySelector('#sender-modal .status-message span:last-child');
  if (statusMsg) {
    statusMsg.textContent = 'Connection lost. Please close and restart sender mode.';
  }

  state.selectedFilePaths = [];
}

function resetReceiverUI() {
  // Close the receiver modal
  if (modals.receiver) {
    modals.receiver.style.display = 'none';
  }

  updateUIElement('receiver-setup', 'display', 'block');
  updateUIElement('receiver-transfer', 'display', 'none');
  updateUIElement('receiver-code-entry', 'display', 'none');
  updateUIElement('receiver-scanning', 'display', 'none');

  const receivedList = document.getElementById('received-files-list');
  if (receivedList) receivedList.innerHTML = '';

  const senderList = document.getElementById('sender-list');
  if (senderList) senderList.innerHTML = '';

  if (buttons.connect) {
    buttons.connect.disabled = false;
    buttons.connect.textContent = '🔗 Connect to Sender';
  }

  if (inputs.receiverCode) {
    inputs.receiverCode.value = '';
  }

  if (buttons.backToList) {
    buttons.backToList.style.display = 'block'; // Show back button for local mode
  }

  state.selectedSender = null;

  // Restore cached path
  const cachedPath = localStorage.getItem('lastSavePath');
  if (cachedPath && inputs.saveLocation) {
    state.saveDirectory = cachedPath;
    inputs.saveLocation.value = cachedPath;
  }
}

// ============================================================================
// PEER JS UTILITIES
// ============================================================================

function initializePeerJS() {
  if (typeof Peer === 'undefined') {
    throw new Error('PeerJS library not loaded');
  }

  return new Peer({
    host: '0.peerjs.com',
    secure: true,
    port: 443,
    debug: 2,
  });
}

function setupPeerEventHandlers(peer, { onOpen, onError, onDisconnected }) {
  peer.on('open', onOpen);
  peer.on('error', onError);
  peer.on('disconnected', onDisconnected);
}

// ============================================================================
// EVENT LISTENERS FROM MAIN PROCESS
// ============================================================================

window.electronAPI.onConnectionStatus((status) => {
  debug.log('Connection status:', status);
  state.isConnected = status.connected;
  state.currentMode = status.mode;

  if (status.connected && status.mode === 'sender') {
    updateUIElement('sender-setup', 'display', 'none');
    updateUIElement('sender-transfer', 'display', 'block');
  } else if (!status.connected && status.mode === 'sender') {
    updateUIElement('sender-setup', 'display', 'block');
    updateUIElement('sender-transfer', 'display', 'none');
  } else if (status.connected && status.mode === 'receiver') {
    updateUIElement('receiver-setup', 'display', 'none');
    updateUIElement('receiver-code-entry', 'display', 'none');
    updateUIElement('receiver-transfer', 'display', 'block');

    const savePathDisplay = document.getElementById('save-path-display');
    if (savePathDisplay) {
      savePathDisplay.textContent = state.saveDirectory || 'Downloads folder';
    }
  } else if (!status.connected && status.mode === 'receiver') {
    updateUIElement('receiver-setup', 'display', 'block');
    updateUIElement('receiver-transfer', 'display', 'none');
  }
});

window.electronAPI.onConnectionLost((info) => {
  debug.error('Connection lost:', info);
  state.isConnected = false;

  setTimeout(() => {
    const messages = {
      sender: {
        title: '🔌 Receiver Disconnected',
        message: 'The receiver has disconnected from your transfer session.',
        action:
          'What you can do:\n\n' +
          '• Wait for the receiver to reconnect (if they return soon)\n' +
          '• Close this window and start a new sender session',
      },
      receiver: {
        title: '🔌 Sender Disconnected',
        message: 'The sender has closed the connection or stopped the transfer.',
        action:
          'What you need to do:\n\n' +
          '• Close this dialog\n' +
          '• Start a new transfer session\n' +
          '• Reconnect to the sender',
      },
    };

    const msg = messages[info.mode];
    if (msg) {
      appuiToast.error(`Connection lost: ${info.reason}`, 5000);
      appuiAlert.show({
        title: msg.title,
        message: `${msg.message}\n\n${msg.action}\n\nReason: ${info.reason || 'Unknown'}`,
        confirm: false,
      });
    }

    resetConnectionUI(info.mode);
  }, 100);
});

window.electronAPI.onFileProgress((progress) => {
  // Add speed tracking for local transfers
  if (state.transferType === 'local') {
    const fileKey = `${progress.currentFile}_${progress.fileName}`;
    
    // Initialize timing for this file if not exists
    if (!state.localTransferState[fileKey]) {
      state.localTransferState[fileKey] = {
        startTime: Date.now(),
        lastUpdateTime: Date.now(),
      };
    }
    
    const fileState = state.localTransferState[fileKey];
    const now = Date.now();
    const elapsed = (now - fileState.startTime) / 1000; // seconds
    const bytes = progress.sentBytes || progress.receivedBytes || 0;
    const speed = elapsed > 0 ? bytes / elapsed : 0;
    
    // Add speed to progress object
    progress.speed = speed;
    
    // Clean up completed files
    if (progress.progress === 100) {
      delete state.localTransferState[fileKey];
    }
  }
  
  if (state.currentMode === 'receiver') {
    ensureReceiverFileItem(progress);
  }
  updateFileProgress(progress);
});

window.electronAPI.onFileReceived((file) => {
  updateReceivedFileComplete(file);
});

window.electronAPI.onTransferComplete(() => {
  state.isTransferring = false;

  if (buttons.sendFiles) {
    buttons.sendFiles.textContent = '✅ All Files Sent!';
    setTimeout(() => {
      buttons.sendFiles.textContent = '🚀 Send Files';
      buttons.sendFiles.disabled = false;
      state.selectedFilePaths = [];
    }, 2000);
  }
});

window.electronAPI.onError((error) => {
  debug.error('Transfer error:', error);

  const errorMessages = {
    ECONNREFUSED:
      '❌ Connection Refused\n\nCould not connect to the sender.\n\nPlease check:\n1. The IP address and port are correct\n2. The sender is running and waiting for connection\n3. Both devices are on the same network\n4. Firewall is not blocking the connection',
    ETIMEDOUT:
      '❌ Connection Timeout\n\nThe connection attempt timed out.\n\nPlease check:\n1. The sender is still running\n2. Network connection is stable\n3. Both devices can reach each other',
    ENOTFOUND:
      '❌ Host Not Found\n\nCould not find the sender at the specified IP address.\n\nPlease verify the IP address is correct.',
  };

  let userMessage = 'Error: ' + error;
  for (const [code, msg] of Object.entries(errorMessages)) {
    if (error.includes(code)) {
      userMessage = msg;
      break;
    }
  }

  appuiAlert.show({
    title: 'Transfer Error',
    message: userMessage,
    confirm: false,
  });
});

// ============================================================================
// MODAL CONTROLS
// ============================================================================

async function handleModalClose(modalId) {
  const modal = document.getElementById(modalId);

  if ((modalId === 'sender-modal' || modalId === 'receiver-modal') && state.isConnected) {
    const shouldClose = await appuiAlert.show({
      title: '⚠️ Warning: You are still connected!',
      message:
        'Closing this window will disconnect the transfer session.\n\nAre you sure you want to close?',
      confirm: true,
    });
    if (!shouldClose) return;

    await cleanupConnection();
  }

  modal.style.display = 'none';

  if (modalId === 'sender-modal' || modalId === 'receiver-modal') {
    await cleanupConnection();
    state.transferType = null;
  }
}

document.querySelectorAll('.close-modal').forEach((btn) => {
  btn.addEventListener('click', () => {
    const modalId = btn.getAttribute('data-modal');
    handleModalClose(modalId);
  });
});

// Open modals
buttons.localTransfer.addEventListener('click', () => {
  modals.mode.style.display = 'block';
  state.transferType = 'local';
});

buttons.remoteTransfer.addEventListener('click', () => {
  modals.mode.style.display = 'block';
  state.transferType = 'remote';
});

buttons.secureTransfer.addEventListener('click', () => {
  modals.mode.style.display = 'block';
  state.transferType = 'secure';
});

buttons.help.addEventListener('click', () => {
  modals.help.style.display = 'block';
});

// ============================================================================
// SENDER MODE
// ============================================================================

buttons.senderMode.addEventListener('click', async () => {
  try {
    modals.mode.style.display = 'none';
    state.currentMode = 'sender';

    const senderFunctions = {
      local: localSender,
      remote: remoteSender,
      secure: secureSender,
    };

    const senderFn = senderFunctions[state.transferType];
    if (senderFn) {
      await senderFn();
    }
  } catch (error) {
    debug.error('Failed to start sender:', error);
    appuiToast.error('Failed to start sender mode: ' + error.message, 5000);
    modals.sender.style.display = 'none';
    state.currentMode = null;
  }
});

async function localSender() {
  // Reset state from any previous connection
  state.isConnected = false;
  state.isTransferring = false;
  state.selectedFilePaths = [];

  modals.sender.style.display = 'block';

  if (buttons.toggleManualDetails) buttons.toggleManualDetails.style.display = 'block';
  updateUIElement('manual-connection-details', 'display', 'none');
  updateUIElement('sender-setup', 'display', 'block');
  updateUIElement('sender-transfer', 'display', 'none');
  document.getElementById('file-list').innerHTML = '';
  if (buttons.sendFiles) buttons.sendFiles.style.display = 'none';

  updateUIElement('service-name', 'text', 'Starting...');
  const statusMsg = document.querySelector('#sender-modal .status-message span:last-child');
  if (statusMsg) statusMsg.textContent = 'Starting local server...';

  const result = await window.electronAPI.startSender(state.transferType);

  const hostname = result.hostname || 'Unknown Device';
  updateUIElement('service-name', 'text', `${hostname} (Local)`);
  updateUIElement('connection-code', 'text', result.code);
  updateUIElement('sender-ip', 'text', result.ip);
  updateUIElement('sender-port', 'text', result.port);

  if (statusMsg) statusMsg.textContent = 'Waiting for receiver to connect (Local Network)...';
}

async function remoteSender() {
  try {
    // Reset state
    state.isConnected = false;
    state.isTransferring = false;
    state.selectedFilePaths = [];

    state.remotePeer = initializePeerJS();

    modals.sender.style.display = 'block';
    
    // Hide manual connection details by default for remote mode
    if (buttons.toggleManualDetails) buttons.toggleManualDetails.style.display = 'none';
    updateUIElement('manual-connection-details', 'display', 'none');
    
    updateUIElement('sender-setup', 'display', 'block');
    updateUIElement('sender-transfer', 'display', 'none');
    document.getElementById('file-list').innerHTML = '';
    if (buttons.sendFiles) buttons.sendFiles.style.display = 'none';

    updateUIElement('service-name', 'text', 'Loading...');
    updateUIElement('connection-code', 'text', 'Loading...');
    const statusMsg = document.querySelector('#sender-modal .status-message span:last-child');
    if (statusMsg) statusMsg.textContent = 'Connecting to PeerJS server...';

    setupPeerEventHandlers(state.remotePeer, {
      onOpen: (id) => {
        debug.log('PeerJS connected:', id);
        updateUIElement('service-name', 'text', 'Remote Transfer (Internet)');
        updateUIElement('connection-code', 'text', id);
        updateUIElement('sender-ip', 'text', 'N/A (P2P)');
        updateUIElement('sender-port', 'text', 'N/A (P2P)');
        if (statusMsg) statusMsg.textContent = 'Waiting for receiver to connect (via Internet)...';
        appuiToast.success('Remote sender ready! Share the code with receiver.', 3000);
      },
      onError: (err) => {
        debug.error('PeerJS error:', err);
        appuiToast.error('PeerJS error: ' + err.message, 5000);
        modals.sender.style.display = 'none';
        state.currentMode = null;
        if (state.remotePeer) {
          state.remotePeer.destroy();
          state.remotePeer = null;
        }
      },
      onDisconnected: () => {
        debug.warn('Disconnected from PeerJS server, attempting to reconnect...');
        appuiToast.warn('Connection lost, reconnecting...', 3000);
        state.remotePeer.reconnect();
      },
    });

    state.remotePeer.on('connection', async (conn) => {
      debug.log('Receiver connected:', conn.peer);
      state.remoteConnection = conn;
      state.isConnected = true;

      if (statusMsg) statusMsg.textContent = 'Receiver connected! Ready to send files.';
      appuiToast.success('Receiver connected via internet!', 3000);

      if (buttons.sendFiles) buttons.sendFiles.style.display = 'block';

      conn.on('data', (data) => {
        // Handle disconnect notification from receiver
        if (data && data.type === 'disconnect-request') {
          debug.log('Receiver disconnecting:', data.reason);
          state.isConnected = false;

          appuiToast.warn('Receiver is disconnecting...', 3000);

          setTimeout(() => {
            appuiAlert.show({
              title: '🔌 Receiver Disconnected',
              message: `The receiver has closed the connection.\n\nReason: ${data.reason || 'Unknown'}\n\nYou can close this window or wait for a new receiver to connect.`,
              confirm: false,
            });

            // Reset sender UI after notification
            resetConnectionUI('sender');
          }, 100);
        }
      });

      conn.on('close', () => {
        if (state.isConnected) {
          // Only show alert if we haven't already been notified via disconnect-request
          state.isConnected = false;
          appuiToast.warn('Receiver disconnected', 3000);
          setTimeout(() => {
            appuiAlert.show({
              title: '🔌 Connection Lost',
              message:
                'The connection to receiver was lost.\n\nYou can close this window or wait for a new receiver to connect.',
              confirm: false,
            });
          }, 100);
        }
      });

      conn.on('error', (err) => {
        debug.error('Connection error:', err);
        appuiToast.error('Connection error: ' + err.message, 5000);
      });

      await window.electronAPI.startSender(state.transferType);
    });
  } catch (error) {
    debug.error('Failed to start remote sender:', error);
    appuiToast.error('Failed to start remote sender: ' + error.message, 5000);
    modals.sender.style.display = 'none';
    state.currentMode = null;
  }
}

async function secureSender() {
  appuiToast.info('Secure transfer coming soon!', 3000);
  appuiAlert.show({
    title: '🔐 Secure Transfer',
    message:
      'This feature adds end-to-end encryption to file transfers.\n\nComing soon! Current transfers use basic TCP without encryption.',
    confirm: false,
  });
}

// Toggle Manual Connection Details
if (buttons.toggleManualDetails) {
  const manualConnectionDetails = document.getElementById('manual-connection-details');
  buttons.toggleManualDetails.addEventListener('click', () => {
    const isHidden = manualConnectionDetails.style.display === 'none';
    manualConnectionDetails.style.display = isHidden ? 'block' : 'none';
    buttons.toggleManualDetails.innerHTML = isHidden
      ? '🔧 Hide Manual Connection Details'
      : '🔧 Show Manual Connection Details';
  });
}

// ============================================================================
// RECEIVER MODE
// ============================================================================

buttons.receiverMode.addEventListener('click', async () => {
  try {
    modals.mode.style.display = 'none';
    state.currentMode = 'receiver';

    const receiverFunctions = {
      local: localReceiver,
      remote: remoteReceiver,
      secure: secureReceiver,
    };

    const receiverFn = receiverFunctions[state.transferType];
    if (receiverFn) {
      await receiverFn();
    }
  } catch (error) {
    state.currentMode = null;
    debug.error('Failed to start receiver:', error);
    appuiToast.error('Failed to start receiver mode: ' + error.message, 5000);
  }
});

async function localReceiver() {
  // Reset state
  state.isConnected = false;
  state.isTransferring = false;
  state.selectedSender = null;
  receiverFileCounter = 0; // Reset file counter for new session

  modals.receiver.style.display = 'block';

  // Reset to auto-discovery mode by default
  updateUIElement('auto-discovery-section', 'display', 'block');
  updateUIElement('manual-connection-section', 'display', 'none');

  // Reset connection method buttons to default state
  if (buttons.autoDiscover && buttons.manualConnect) {
    buttons.autoDiscover.style.background = '#4caf50'; // Active
    buttons.manualConnect.style.background = '#666'; // Inactive
  }

  if (buttons.toggleManualDetails) buttons.toggleManualDetails.style.display = 'block';
  updateUIElement('manual-connection-details', 'display', 'none');
  updateUIElement('receiver-transfer', 'display', 'none');
  updateUIElement('receiver-code-entry', 'display', 'none');

  document.getElementById('received-files-list').innerHTML = '';

  // Clear manual input fields
  if (inputs.manualIp) {
    inputs.manualIp.value = '';
    inputs.manualIp.style.border = ''; // Reset border
  }
  if (inputs.manualPort) {
    inputs.manualPort.value = '';
    inputs.manualPort.style.border = ''; // Reset border
  }

  const savedPath = localStorage.getItem('lastSavePath');
  if (savedPath && inputs.saveLocation) {
    inputs.saveLocation.value = savedPath;
    state.saveDirectory = savedPath;
  } else if (inputs.saveLocation) {
    inputs.saveLocation.value = '';
    state.saveDirectory = '';
  }

  await discoverAvailableSenders();
}

async function remoteReceiver() {
  try {
    // Reset state
    state.isConnected = false;
    state.isTransferring = false;
    state.selectedSender = null;
    receiverFileCounter = 0; // Reset file counter for new session

    state.remotePeer = initializePeerJS();

    modals.receiver.style.display = 'block';
    updateUIElement('auto-discovery-section', 'display', 'none');
    updateUIElement('manual-connection-section', 'display', 'none');
    updateUIElement('receiver-setup', 'display', 'none');
    updateUIElement('receiver-code-entry', 'display', 'block');
    updateUIElement('receiver-transfer', 'display', 'none');
    document.getElementById('received-files-list').innerHTML = '';

    // Load saved path from localStorage (same as local receiver)
    const savedPath = localStorage.getItem('lastSavePath');
    if (savedPath && inputs.saveLocation) {
      inputs.saveLocation.value = savedPath;
      state.saveDirectory = savedPath;
    } else if (inputs.saveLocation) {
      inputs.saveLocation.value = '';
      state.saveDirectory = '';
    }

    if (inputs.receiverCode) {
      inputs.receiverCode.value = '';
      inputs.receiverCode.placeholder = 'Enter sender peer ID';
      inputs.receiverCode.setAttribute('maxlength', '100');
      setTimeout(() => inputs.receiverCode.focus(), 100);
    }

    if (buttons.backToList) buttons.backToList.style.display = 'none';
    updateUIElement('selected-sender-name', 'text', 'Remote Sender (Internet)');

    appuiToast.info('Connecting to PeerJS server...', 3000);

    setupPeerEventHandlers(state.remotePeer, {
      onOpen: (id) => {
        debug.log('PeerJS receiver ready:', id);
        appuiToast.success('Ready to connect to sender!', 3000);
      },
      onError: (err) => {
        debug.error('PeerJS error:', err);
        appuiToast.error('PeerJS error: ' + err.message, 5000);
        modals.receiver.style.display = 'none';
        state.currentMode = null;
        if (state.remotePeer) {
          state.remotePeer.destroy();
          state.remotePeer = null;
        }
        if (buttons.connect) {
          buttons.connect.disabled = false;
          buttons.connect.textContent = '🔗 Connect to Sender';
        }
      },
      onDisconnected: () => {
        debug.warn('Disconnected from PeerJS server, attempting to reconnect...');
        appuiToast.warn('Connection lost, reconnecting...', 3000);
        state.remotePeer.reconnect();
      },
    });
  } catch (error) {
    debug.error('Failed to start remote receiver:', error);
    appuiToast.error('Failed to start remote receiver: ' + error.message, 5000);
    modals.receiver.style.display = 'none';
    state.currentMode = null;
  }
}

async function secureReceiver() {
  appuiToast.info('Secure transfer coming soon!', 3000);
  appuiAlert.show({
    title: '🔐 Secure Transfer',
    message:
      'This feature adds end-to-end encryption to file transfers.\n\nComing soon! Current transfers use basic TCP without encryption.',
    confirm: false,
  });
}

// ============================================================================
// SENDER DISCOVERY & CONNECTION
// ============================================================================

async function discoverAvailableSenders() {
  try {
    updateUIElement('receiver-scanning', 'display', 'block');
    updateUIElement('receiver-setup', 'display', 'none');
    updateUIElement('receiver-code-entry', 'display', 'none');
    updateUIElement('auto-discovery-section', 'display', 'block');

    const services = await window.electronAPI.discoverServices();
    state.discoveredSenders = services;

    updateUIElement('receiver-scanning', 'display', 'none');
    updateUIElement('receiver-setup', 'display', 'block');

    const senderListContainer = document.getElementById('sender-list');
    senderListContainer.innerHTML = '';

    if (services.length === 0) {
      senderListContainer.innerHTML =
        '<p style="text-align: center; color: #999; padding: 20px;">No senders found nearby. Make sure sender is running.</p>';
    } else {
      services.forEach((service, index) => {
        const senderItem = document.createElement('div');
        senderItem.className = 'sender-item';
        senderItem.dataset.index = index;
        senderItem.innerHTML = `
          <div class="sender-info">
            <strong>${service.name}</strong>
            <small>${service.host}:${service.port}</small>
          </div>
          <div class="sender-action">→</div>
        `;
        senderItem.addEventListener('click', () => selectSender(index));
        senderListContainer.appendChild(senderItem);
      });
    }
  } catch (error) {
    debug.error('Failed to discover senders:', error);
    updateUIElement('receiver-scanning', 'display', 'none');
    updateUIElement('receiver-setup', 'display', 'block');

    const senderListContainer = document.getElementById('sender-list');
    senderListContainer.innerHTML = `
      <div style="text-align: center; padding: 20px;">
        <p style="color: #e53e3e; margin-bottom: 10px;">⚠️ Failed to scan for senders</p>
        <p style="color: #999; font-size: 0.9em; margin-bottom: 15px;">${error.message || 'Unknown error'}</p>
        <p style="color: #666; font-size: 0.85em;">Make sure:</p>
        <ul style="color: #666; font-size: 0.85em; text-align: left; display: inline-block; margin: 10px 0;">
          <li>Sender is running on the same network</li>
          <li>Both devices are on the same Wi-Fi/network</li>
          <li>Firewall allows mDNS (port 5353 UDP)</li>
        </ul>
      </div>
    `;
  }
}

function selectSender(index) {
  state.selectedSender = state.discoveredSenders[index];
  debug.log('Selected sender:', state.selectedSender);

  updateUIElement('receiver-setup', 'display', 'none');
  updateUIElement('receiver-code-entry', 'display', 'block');
  updateUIElement('selected-sender-name', 'text', state.selectedSender.name);

  if (inputs.receiverCode) {
    inputs.receiverCode.value = '';
    inputs.receiverCode.placeholder = 'XXX-XXX';
    inputs.receiverCode.setAttribute('maxlength', '7');
    setTimeout(() => inputs.receiverCode.focus(), 100);
  }
}

// ============================================================================
// CONNECTION HANDLERS
// ============================================================================

buttons.connect.addEventListener('click', async () => {
  if (state.transferType === 'remote') {
    await handleRemoteConnection();
  } else {
    await handleLocalConnection();
  }
});

async function handleRemoteConnection() {
  const peerID = inputs.receiverCode.value.trim();
  const currentSavePath = inputs.saveLocation.value.trim();

  // Validate peer ID
  if (!peerID) {
    appuiToast.warn('Please enter the sender peer ID', 4000);
    return;
  }

  // Validate save directory is selected
  if (!currentSavePath) {
    appuiToast.warn('⚠️ Please select a save location first!', 4000);
    appuiAlert.show({
      title: '📁 Save Location Required',
      message:
        'You must select a folder where received files will be saved.\n\nClick the "Browse" button to choose a location.',
      confirm: false,
    });
    return;
  }

  try {
    buttons.connect.textContent = '⏳ Connecting...';
    buttons.connect.disabled = true;

    debug.log('Connecting to sender peer:', peerID);
    state.remoteConnection = state.remotePeer.connect(peerID, { reliable: true });

    state.remoteConnection.on('open', () => {
      state.isConnected = true;

      updateUIElement('receiver-code-entry', 'display', 'none');
      updateUIElement('receiver-transfer', 'display', 'block');

      // Save the selected directory
      state.saveDirectory = currentSavePath;

      const savePathDisplay = document.getElementById('save-path-display');
      if (savePathDisplay) {
        savePathDisplay.textContent = state.saveDirectory || 'Downloads folder';
      }

      if (state.saveDirectory) savePath(state.saveDirectory);

      appuiToast.success('Connected to sender! Waiting for files...', 3000);
      buttons.connect.textContent = '🔗 Connect to Sender';
      buttons.connect.disabled = false;
    });

    state.remoteConnection.on('data', handleRemoteData);

    state.remoteConnection.on('close', () => {
      if (state.isConnected) {
        // Only show alert if we haven't already been notified via disconnect-request
        state.isConnected = false;
        appuiToast.warn('Sender disconnected', 3000);
        setTimeout(() => {
          appuiAlert.show({
            title: '🔌 Connection Lost',
            message:
              'The connection to sender was lost.\n\nPlease close this window and start a new transfer if needed.',
            confirm: false,
          });
        }, 100);
      }
    });

    state.remoteConnection.on('error', (err) => {
      debug.error('Connection error:', err);
      appuiToast.error('Connection error: ' + err.message, 5000);
      buttons.connect.textContent = '🔗 Connect to Sender';
      buttons.connect.disabled = false;
    });
  } catch (error) {
    debug.error('Failed to connect:', error);
    appuiToast.error('Failed to connect: ' + error.message, 5000);
    buttons.connect.textContent = '🔗 Connect to Sender';
    buttons.connect.disabled = false;
  }
}

async function handleLocalConnection() {
  const code = inputs.receiverCode.value.trim().toUpperCase();
  const currentSavePath = inputs.saveLocation.value.trim();

  // Validate connection code
  if (!code || code.length < 7) {
    appuiToast.warn('Please enter the complete connection code (format: XXX-XXX)', 4000);
    return;
  }

  // Validate sender is selected
  if (!state.selectedSender) {
    appuiToast.warn('No sender selected. Please go back and select a sender.', 4000);
    return;
  }

  // Validate save directory is selected
  if (!currentSavePath) {
    appuiToast.warn('⚠️ Please select a save location first!', 4000);
    appuiAlert.show({
      title: '📁 Save Location Required',
      message:
        'You must select a folder where received files will be saved.\n\nClick the "Browse" button to choose a location.',
      confirm: false,
    });
    return;
  }

  try {
    buttons.connect.textContent = '⏳ Connecting...';
    buttons.connect.disabled = true;

    // Log discovered connection details
    debug.log('Connecting via Bonjour:', {
      ip: state.selectedSender.host,
      port: state.selectedSender.port,
      name: state.selectedSender.name,
    });

    const result = await window.electronAPI.connectToSender(
      state.selectedSender.host,
      state.selectedSender.port,
      code,
      currentSavePath || undefined
    );

    if (result && result.saveDir) {
      savePath(result.saveDir);
    }
  } catch (error) {
    debug.error('Connection failed:', error);

    let errorMsg = error.message;
    if (errorMsg.includes('Invalid connection code')) {
      errorMsg =
        '❌ Invalid Connection Code\n\nThe code you entered does not match.\nPlease check the code and try again.';
    }

    appuiAlert.show({
      title: 'Connection Failed',
      message: errorMsg,
      confirm: false,
    });
    buttons.connect.textContent = '🔗 Connect';
    buttons.connect.disabled = false;
  }
}

// Track incoming files for remote transfer
const incomingFiles = {};
const fileWriteQueues = {}; // Queue system for each file to prevent concurrent writes
let receiverFileCounter = 0; // Counter for file numbers to avoid duplicates

// Process write queue for a specific file
async function processWriteQueue(queueKey, actualFileName, originalFileName, transferId) {
  const queue = fileWriteQueues[queueKey];
  if (!queue || queue.isProcessing || queue.items.length === 0) {
    return;
  }

  queue.isProcessing = true;

  while (queue.items.length > 0) {
    const { combined, receivedChunks } = queue.items.shift();
    
    try {
      await window.electronAPI.appendFileChunk(actualFileName, combined, state.saveDirectory);

      // Send acknowledgment only if receivedChunks is provided (every 20 chunks)
      if (receivedChunks !== null && receivedChunks !== undefined) {
        if (state.remoteConnection && state.remoteConnection.open) {
          state.remoteConnection.send({
            type: 'chunk-ack',
            fileName: originalFileName || fileName,
            transferId: transferId,
            receivedChunks: receivedChunks,
          });
          debug.log(`ACK sent for ${originalFileName || fileName} (${transferId}): ${receivedChunks} chunks`);
        }
      }
    } catch (error) {
      debug.error(`Failed to write chunk for ${fileName}:`, error);
      appuiToast.error(`Error writing ${fileName}: ${error.message}`, 5000);
      // Continue processing remaining items even if one fails
    }
  }

  queue.isProcessing = false;
}

async function handleRemoteData(data) {
  // Handle disconnect notification from sender
  if (data.type === 'disconnect-request') {
    debug.log('Sender disconnecting:', data.reason);
    state.isConnected = false;

    appuiToast.warn('Sender is disconnecting...', 3000);

    setTimeout(() => {
      appuiAlert.show({
        title: '🔌 Sender Disconnected',
        message: `The sender has closed the connection.\n\nReason: ${data.reason || 'Unknown'}\n\nPlease close this window and start a new transfer if needed.`,
        confirm: false,
      });
      // Reset UI after notification
      resetConnectionUI('receiver');
    }, 100);

    return;
  }

  // Handle file metadata
  if (data.type === 'file-meta') {
    receiverFileCounter++; // Increment counter for each new file
    const fileCount = receiverFileCounter;
    const transferId = data.transferId; // Use unique transfer ID from sender

    incomingFiles[transferId] = {
      totalChunks: data.totalChunks,
      receivedChunks: 0,
      fileSize: data.fileSize,
      fileNumber: fileCount,
      receivedBytes: 0,
      streaming: true, // Use streaming mode for all files
      bufferQueue: [], // Buffer for batching writes
      bufferedBytes: 0, // Track buffered size
      startTime: Date.now(),
      lastUpdateTime: 0, // Set to 0 so first update happens immediately
      originalFileName: data.fileName, // Store original name for display
      transferId: transferId, // Store transfer ID for tracking
    };

    // Store actual file name for write queue (will be set after initFileStream)
    // We'll use transferId as the key for write queues to support duplicate file names

    // Initialize file stream on disk
    window.electronAPI
      .initFileStream(data.fileName, state.saveDirectory)
      .then((result) => {
        debug.log(`Stream init: ${data.fileName} (${transferId})`);
        
        // If backend renamed the file, store the actual name
        if (result.fileName && result.fileName !== data.fileName) {
          debug.log(`Renamed: ${data.fileName} -> ${result.fileName}`);
          // Store the actual file name being saved
          incomingFiles[transferId].actualFileName = result.fileName;
          // originalFileName remains as sender's name
        }
        
        // Initialize write queue using transferId as key (not filename)
        fileWriteQueues[transferId] = {
          items: [],
          isProcessing: false,
        };
      })
      .catch((error) => {
        debug.error(`Failed to initialize file stream: ${error.message}`);
        appuiToast.error(`Failed to start receiving ${data.fileName}`, 5000);
      });

    // Create file item in UI using generalized function (same as local)
    ensureReceiverFileItem({
      currentFile: fileCount,
      fileName: data.fileName
    });

    debug.log(`[REMOTE] Receiving ${data.fileName}: 0/${data.totalChunks} chunks`);
    return;
  }

  // Handle file chunks
  if (data.type === 'file-chunk') {
    // Use transfer ID to find the correct file transfer
    const transferId = data.transferId;
    const file = incomingFiles[transferId];
    
    if (file) {
      // Use actual file name if it was renamed (e.g., duplicate handling)
      const actualFileName = file.actualFileName || file.originalFileName;
      
      // Decode base64 chunk back to Uint8Array using safe method
      const bytes = base64ToArrayBuffer(data.chunk);
      
      // Clear the base64 data from memory immediately after decoding
      data.chunk = null;

      // Add to buffer queue
      file.bufferQueue.push(bytes);
      file.bufferedBytes += bytes.length;
      file.receivedChunks++;
      file.receivedBytes += bytes.length;

      const progress = Math.round((file.receivedBytes / file.fileSize) * 100);
      const now = Date.now();
      const elapsed = (now - file.startTime) / 1000; // seconds
      const speed = elapsed > 0 ? file.receivedBytes / elapsed : 0;

      // Send ACK every 20 chunks or on last chunk (synchronized with sender WINDOW_SIZE)
      const shouldSendAck = (file.receivedChunks % 20 === 0) || file.receivedChunks === file.totalChunks;
      
      // Flush buffer more frequently (1MB) to prevent memory issues
      const shouldFlush = file.bufferedBytes >= 1024 * 1024 || file.receivedChunks === file.totalChunks;

      // CRITICAL: Send ACK immediately to prevent sender timeout
      if (shouldSendAck) {
        if (state.remoteConnection && state.remoteConnection.open) {
          state.remoteConnection.send({
            type: 'chunk-ack',
            fileName: file.originalFileName,
            transferId: file.transferId,
            receivedChunks: file.receivedChunks,
          });
          debug.log(`ACK: ${file.receivedChunks}/${file.transferId}`);
        }
      }

      // Update UI every 100ms for smooth progress feedback
      const timeSinceLastUpdate = now - file.lastUpdateTime;
      if (timeSinceLastUpdate >= 100) {
        file.lastUpdateTime = now;
        updateFileProgress({
          currentFile: file.fileNumber,
          fileName: data.fileName,
          receivedBytes: file.receivedBytes,
          totalBytes: file.fileSize,
          progress: progress,
          speed: speed,
        });
      }

      if (shouldFlush) {
        // CRITICAL: Apply backpressure if write queue is too full to prevent memory overflow
        const queue = fileWriteQueues[transferId];
        if (queue && queue.items.length > 5) {
          // If queue is very full, wait briefly for it to drain (non-blocking)
          let waitCount = 0;
          while (queue.items.length > 3 && queue.isProcessing && waitCount < 100) {
            await new Promise(resolve => setTimeout(resolve, 10));
            waitCount++;
          }
        }
        
        // Merge all buffered chunks into one
        const combined = mergeBuffers(file.bufferQueue);
        
        // Clear buffer immediately to prevent re-processing
        file.bufferQueue = [];
        file.bufferedBytes = 0;

        // Add to write queue instead of writing directly (use transferId as key)
        if (!fileWriteQueues[transferId]) {
          fileWriteQueues[transferId] = { items: [], isProcessing: false };
        }
        
        // Don't send ACK here - already sent above
        fileWriteQueues[transferId].items.push({
          combined: combined,
          receivedChunks: null, // ACK already sent immediately above
        });

        // Start processing the queue (non-blocking)
        // Pass transferId, actual file name, original file name for ACK
        processWriteQueue(transferId, actualFileName, file.originalFileName, file.transferId);
      }
    }
    return;
  }

  // Handle file complete
  if (data.type === 'file-complete') {
    const transferId = data.transferId;
    const file = incomingFiles[transferId];
    
    if (file) {
      const actualFileName = file.actualFileName || file.originalFileName;
      
      debug.log(`[COMPLETE] ${file.originalFileName} (${transferId})`);
      
      // Force final progress update to 100%
      updateFileProgress({
        currentFile: file.fileNumber,
        fileName: file.originalFileName,
        receivedBytes: file.fileSize,
        totalBytes: file.fileSize,
        progress: 100,
        speed: 0,
      });
      
      // Wait for write queue to finish processing (use transferId as key) with timeout
      const queue = fileWriteQueues[transferId];
      if (queue) {
        debug.log(`[COMPLETE] Waiting for queue: ${file.originalFileName}`);
        let waitCount = 0;
        const maxWait = 200; // 10 seconds max wait (200 * 50ms)
        while ((queue.items.length > 0 || queue.isProcessing) && waitCount < maxWait) {
          await new Promise(resolve => setTimeout(resolve, 50));
          waitCount++;
        }
        if (waitCount >= maxWait) {
          debug.warn(`[COMPLETE] Queue timeout: ${file.originalFileName}`);
        }
      }
      
      // Finalize the file stream (already saved incrementally to disk)
      debug.log(`[COMPLETE] Finalizing: ${actualFileName}`);
      window.electronAPI
        .finalizeFile(actualFileName, state.saveDirectory)
        .then((result) => {
          debug.log(`[COMPLETE] Success: ${actualFileName}`);
          
          // Update UI using generalized function (same as local transfers)
          finalizeReceivedFileUI({
            fileNumber: file.fileNumber,
            fileName: file.originalFileName,
            originalFileName: file.originalFileName,
            actualFileName: actualFileName,
            fileSize: file.fileSize,
            savePath: result.path || state.saveDirectory
          });

          // Clean up tracking objects and free memory
          if (file.bufferQueue) {
            file.bufferQueue = [];
          }
          delete incomingFiles[transferId];
          delete fileWriteQueues[transferId];
          
          // Force garbage collection hint (only if exposed)
          if (typeof window !== 'undefined' && window.gc) {
            try {
              window.gc();
            } catch (e) {
              // Ignore if gc not available
            }
          }

          // Check if all files received
          if (Object.keys(incomingFiles).length === 0) {
            appuiToast.success('All files received successfully!', 4000);
          }
        })
        .catch((error) => {
          debug.error(`[COMPLETE] Failed to finalize ${file.originalFileName}:`, error);
          appuiToast.error(`Failed to save ${file.originalFileName}: ${error.message}`, 5000);
          
          // Update UI to show error (same format as success, but with error indicator)
          const fileList = document.getElementById('received-files-list');
          const fileItem = fileList.querySelector(`[data-file-number="${file.fileNumber}"]`);
          if (fileItem) {
            const sizeElement = fileItem.querySelector('.file-size');
            const statusElement = fileItem.querySelector('.file-status');
            if (sizeElement) {
              sizeElement.textContent = `${formatFileSize(file.fileSize)} - Error saving file`;
            }
            if (statusElement) statusElement.textContent = '❌';
          }
        });
    } else {
      debug.error(`[COMPLETE] File not found: ${transferId}`);
    }
    return;
  }
}

// ============================================================================
// RECEIVER BUTTON HANDLERS
// ============================================================================

if (buttons.refreshSenders) {
  buttons.refreshSenders.addEventListener('click', () => discoverAvailableSenders());
}

if (buttons.backToList) {
  buttons.backToList.addEventListener('click', () => {
    state.selectedSender = null;
    updateUIElement('receiver-code-entry', 'display', 'none');
    updateUIElement('receiver-setup', 'display', 'block');

    if (inputs.manualIp) inputs.manualIp.value = '';
    if (inputs.manualPort) inputs.manualPort.value = '';
  });
}

if (buttons.autoDiscover && buttons.manualConnect) {
  buttons.autoDiscover.addEventListener('click', () => {
    buttons.autoDiscover.style.background = '#4caf50';
    buttons.manualConnect.style.background = '#666';
    updateUIElement('auto-discovery-section', 'display', 'block');
    updateUIElement('manual-connection-section', 'display', 'none');
    discoverAvailableSenders();
  });

  buttons.manualConnect.addEventListener('click', () => {
    buttons.manualConnect.style.background = '#4caf50';
    buttons.autoDiscover.style.background = '#666';
    updateUIElement('auto-discovery-section', 'display', 'none');
    updateUIElement('manual-connection-section', 'display', 'block');
  });
}

// Manual IP input validation
if (inputs.manualIp) {
  inputs.manualIp.addEventListener('input', (e) => {
    const input = e.target;
    const cursorPosition = input.selectionStart;

    let value = input.value.replace(/[^0-9.]/g, '').replace(/\.{2,}/g, '.');
    const parts = value.split('.');
    if (parts.length > 4) {
      value = parts.slice(0, 4).join('.');
    }

    input.value = value;
    input.setSelectionRange(cursorPosition, cursorPosition);
    input.style.border = isValidIP(input.value) ? '2px solid green' : '2px solid red';
  });
}

// Manual port input validation
if (inputs.manualPort) {
  inputs.manualPort.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '');
    e.target.style.border = isValidPort(e.target.value) ? '2px solid green' : '2px solid red';
  });
}

// Manual connection proceed
if (buttons.manualProceed) {
  buttons.manualProceed.addEventListener('click', () => {
    const ip = inputs.manualIp.value.trim();
    const port = parseInt(inputs.manualPort.value.trim(), 10);

    if (!ip) {
      appuiToast.warn('Please enter the sender IP address', 4000);
      inputs.manualIp.focus();
      return;
    }

    if (!isValidIP(ip)) {
      appuiToast.warn('Invalid IP address format. Example: 192.168.1.100', 4000);
      inputs.manualIp.focus();
      return;
    }

    const octets = ip.split('.');
    if (octets.some((octet) => parseInt(octet, 10) > 255)) {
      appuiToast.warn('Invalid IP address. Each number must be between 0-255', 4000);
      inputs.manualIp.focus();
      return;
    }

    if (!port || port < 1024 || port > 65535) {
      appuiToast.warn('Please enter a valid port number (1024-65535)', 4000);
      inputs.manualPort.focus();
      return;
    }

    state.selectedSender = {
      name: `Manual: ${ip}:${port}`,
      host: ip,
      port: port,
      addresses: [ip],
      manual: true,
    };

    debug.log('Manual sender:', state.selectedSender);

    updateUIElement('receiver-setup', 'display', 'none');
    updateUIElement('receiver-code-entry', 'display', 'block');
    updateUIElement('selected-sender-name', 'text', state.selectedSender.name);

    if (inputs.receiverCode) {
      inputs.receiverCode.value = '';
      inputs.receiverCode.placeholder = 'XXX-XXX';
      inputs.receiverCode.setAttribute('maxlength', '7');
      setTimeout(() => inputs.receiverCode.focus(), 100);
    }
  });
}

// Auto-format connection code input
if (inputs.receiverCode) {
  inputs.receiverCode.addEventListener('input', (e) => {
    if (state.transferType === 'local') {
      let value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (value.length > 3) {
        value = value.slice(0, 3) + '-' + value.slice(3, 6);
      }
      e.target.value = value;
    }
  });
}

// Browse folder
if (buttons.browseFolder) {
  buttons.browseFolder.addEventListener('click', async () => {
    try {
      const result = await window.electronAPI.selectFolder();
      if (!result.canceled && result.folderPath) {
        inputs.saveLocation.value = result.folderPath;
        savePath(result.folderPath);
      }
    } catch (error) {
      debug.error('Failed to select folder:', error);
      appuiToast.error('Failed to select folder: ' + error.message, 5000);
    }
  });
}

// ============================================================================
// FILE SELECTION AND SENDING
// ============================================================================

inputs.fileDropZone.addEventListener('click', async () => {
  if (state.isTransferring) {
    appuiToast.warn(
      '⚠️ Transfer in progress! Please wait for the current transfer to complete before selecting new files.',
      5000
    );
    return;
  }

  try {
    const result = await window.electronAPI.selectFiles();
    if (!result.canceled && result.filePaths.length > 0) {
      if (state.selectedFilePaths.length === 0) {
        state.selectedFilePaths = result.filePaths;
        document.getElementById('file-list').innerHTML = '';
      } else {
        state.selectedFilePaths.push(...result.filePaths);
      }

      displaySelectedFiles(state.selectedFilePaths);

      if (buttons.sendFiles) {
        buttons.sendFiles.disabled = false;
        buttons.sendFiles.textContent = '🚀 Send Files';
        buttons.sendFiles.style.display = 'block';
      }
    }
  } catch (error) {
    debug.error('Failed to select files:', error);
    appuiToast.error('Failed to select files: ' + error.message, 5000);
  }
});

// Drag and drop
inputs.fileDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  inputs.fileDropZone.classList.add('drag-over');
});

inputs.fileDropZone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  inputs.fileDropZone.classList.remove('drag-over');
});

inputs.fileDropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  inputs.fileDropZone.classList.remove('drag-over');

  if (state.isTransferring) {
    appuiToast.warn(
      '⚠️ Transfer in progress! Please wait for the current transfer to complete before adding new files.',
      5000
    );
    return;
  }

  try {
    const files = Array.from(e.dataTransfer.files);
    const filePaths = [];

    for (const file of files) {
      const filePath = window.electronAPI.getFilePathFromFile(file);
      if (filePath) filePaths.push(filePath);
    }

    if (filePaths.length > 0) {
      if (state.selectedFilePaths.length === 0) {
        state.selectedFilePaths = filePaths;
        document.getElementById('file-list').innerHTML = '';
      } else {
        state.selectedFilePaths.push(...filePaths);
      }

      displaySelectedFiles(state.selectedFilePaths);
      debug.log(`Dropped ${filePaths.length} file(s)`);
    } else {
      appuiToast.error('Could not get file paths. Please use the "Browse" button instead.', 5000);
    }
  } catch (error) {
    debug.error('Error handling dropped files:', error);
    appuiToast.error('Failed to process dropped files: ' + error.message, 5000);
  }
});

function displaySelectedFiles(filePaths) {
  const fileList = document.getElementById('file-list');
  fileList.innerHTML = '';

  filePaths.forEach((filePath, index) => {
    const fileName = filePath.split(/[/\\]/).pop();
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.dataset.filePath = filePath;
    fileItem.innerHTML = `
      <span class="file-icon">📄</span>
      <div class="file-info">
        <div class="file-name">${fileName}</div>
        <div class="file-size">Ready to send</div>
      </div>
      <span class="file-remove" data-file-index="${index}">🗑️</span>
      <span class="file-status">⏳</span>
    `;
    fileList.appendChild(fileItem);
  });

  if (filePaths.length > 0) {
    buttons.sendFiles.style.display = 'block';
    buttons.sendFiles.disabled = false;
  } else {
    buttons.sendFiles.style.display = 'none';
  }
}

// Remove file from list
document.getElementById('file-list').addEventListener('click', (e) => {
  if (e.target.classList.contains('file-remove')) {
    const fileIndex = parseInt(e.target.dataset.fileIndex, 10);
    state.selectedFilePaths.splice(fileIndex, 1);
    displaySelectedFiles(state.selectedFilePaths);
  }
});

// Send files
if (buttons.sendFiles) {
  buttons.sendFiles.addEventListener('click', async () => {
    if (state.selectedFilePaths.length === 0) {
      appuiToast.warn('No files selected', 4000);
      return;
    }

    try {
      state.isTransferring = true;
      document.querySelectorAll('.file-remove').forEach((el) => (el.style.display = 'none'));
      buttons.sendFiles.disabled = true;
      buttons.sendFiles.textContent = '⏳ Sending...';
      
      if (state.transferType === 'local') {
        // Reset local transfer state for new transfer
        state.localTransferState = {};
        await window.electronAPI.sendFiles(state.selectedFilePaths);
      } else if (state.transferType === 'remote' && state.remoteConnection) {
        await sendFilesToRemote(state.selectedFilePaths);
      }
    } catch (error) {
      debug.error('Failed to send files:', error);
      appuiToast.error('Failed to send files: ' + error.message, 5000);
      buttons.sendFiles.textContent = '🚀 Send Files';
      buttons.sendFiles.disabled = false;
      state.isTransferring = false;
    }
  });
}

async function sendFilesToRemote(selectedFilePaths) {
  if (!state.remoteConnection || !state.remoteConnection.open) {
    appuiToast.error('Not connected to receiver. Please wait for connection first.', 5000);
    buttons.sendFiles.textContent = '🚀 Send Files';
    buttons.sendFiles.disabled = false;
    state.isTransferring = false;
    return;
  }
  const CHUNK_SIZE = 256 * 1024; // 256KB chunks for faster transfer
  const WINDOW_SIZE = 20; // Send 20 chunks, then wait for ACK
  const ACK_INTERVAL = 20; // Send ACK every 20 chunks
  let successCount = 0;
  let failCount = 0;
  const sendingFiles = {}; // Track acknowledgment state per file

  for (let fileIndex = 0; fileIndex < selectedFilePaths.length; fileIndex++) {
    const filePath = selectedFilePaths[fileIndex];
    const currentFileNumber = fileIndex + 1;
    let filename = '';

    try {
      filename = filePath.split(/[/\\]/).pop();
      
      // Generate unique transfer ID to handle sending same file multiple times
      const transferId = `${filename}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Get file size first
      const fileSize = await window.electronAPI.getFileSize(filePath);
      const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

      // Send file metadata with unique transfer ID
      state.remoteConnection.send({
        type: 'file-meta',
        fileName: filename,
        transferId: transferId,
        fileSize: fileSize,
        totalChunks: totalChunks,
      });

      debug.log(`Sending ${filename} (${transferId}): ${totalChunks} chunks`);

      // Initialize flow control for this file using transfer ID
      sendingFiles[transferId] = {
        fileName: filename,
        acknowledgedChunks: 0,
        ackPromise: null,
        ackResolve: null,
        startTime: Date.now(),
        lastUpdateTime: Date.now(),
      };

      // Set up ONE acknowledgment listener (not per file)
      if (!state.remoteConnection._hasAckListener) {
        state.remoteConnection.on('data', (data) => {
          if (data.type === 'chunk-ack') {
            const file = sendingFiles[data.transferId];
            if (file) {
              debug.log(`ACK: ${data.receivedChunks}/${data.transferId}`);
              file.acknowledgedChunks = data.receivedChunks;
              if (file.ackResolve) {
                file.ackResolve();
                file.ackResolve = null;
              }
            }
          }
        });
        state.remoteConnection._hasAckListener = true;
      }

      // Send file chunks by reading stream
      let offset = 0;
      let sentBytes = 0;

      for (let i = 0; i < totalChunks; i++) {
        // Flow control: wait if we're too far ahead of receiver
        if (i > 0 && i % WINDOW_SIZE === 0) {
          const file = sendingFiles[transferId];
          const minRequiredAck = i - WINDOW_SIZE; // Must have ACK for at least WINDOW_SIZE chunks ago
          
          // Wait for receiver to catch up with timeout
          let waitCount = 0;
          while (file.acknowledgedChunks < minRequiredAck && waitCount < 500) {
            await new Promise(resolve => setTimeout(resolve, 10));
            waitCount++;
          }
          
          if (waitCount >= 500) {
            debug.warn(`ACK timeout at chunk ${i}: Expected ${minRequiredAck}, Got ${file.acknowledgedChunks}`);
          }
        }

        // Read chunk from file stream (one by one, sequentially)
        const result = await window.electronAPI.readFileChunk(filePath, offset, CHUNK_SIZE);

        // Convert chunk to base64 for transmission using safe method
        const base64Chunk = arrayBufferToBase64(result.chunk);

        // Send chunk sequentially - wait for each send to complete
        state.remoteConnection.send({
          type: 'file-chunk',
          fileName: filename,
          transferId: transferId,
          chunkIndex: i,
          chunk: base64Chunk,
        });
        
        // Small delay between chunks to ensure sequential processing and prevent overwhelming receiver
        await new Promise(resolve => setTimeout(resolve, 1));

        sentBytes += result.bytesRead;
        offset += result.bytesRead;

        // Update UI every 300ms or last chunk (matches receiver update rate)
        const now = Date.now();
        const timeSinceLastUpdate = now - sendingFiles[transferId].lastUpdateTime;
        if (timeSinceLastUpdate >= 300 || i === totalChunks - 1) {
          sendingFiles[transferId].lastUpdateTime = now;
          const progress = Math.round((sentBytes / fileSize) * 100);
          const elapsed = (now - sendingFiles[transferId].startTime) / 1000;
          const speed = elapsed > 0 ? sentBytes / elapsed : 0;
          
          updateFileProgress({
            currentFile: currentFileNumber,
            fileName: filename,
            sentBytes: sentBytes,
            totalBytes: fileSize,
            progress: progress,
            speed: speed,
          });
        }
      }

      // Wait for final acknowledgment before marking complete
      const finalTarget = totalChunks;
      let finalWaitCount = 0;
      while (sendingFiles[transferId].acknowledgedChunks < finalTarget && finalWaitCount < 300) {
        await new Promise(resolve => setTimeout(resolve, 10));
        finalWaitCount++;
      }
      
      if (finalWaitCount >= 300) {
        debug.warn(`Final ACK timeout: ${filename}, received ${sendingFiles[transferId].acknowledgedChunks}/${finalTarget}`);
      }

      // Send file complete with transferId
      state.remoteConnection.send({
        type: 'file-complete',
        fileName: filename,
        transferId: transferId,
        fileSize: fileSize,
      });

      // Clean up flow control state
      delete sendingFiles[transferId];

      // Mark file as complete in UI
      const fileItems = document.querySelectorAll('#file-list .file-item');
      const currentItem = fileItems[fileIndex];
      if (currentItem) {
        const statusElement = currentItem.querySelector('.file-status');
        if (statusElement) statusElement.textContent = '✅';
      }

      debug.log(`Finished sending file: ${filename}`);
      appuiToast.success(`${filename} sent successfully!`, 3000);
      successCount++;
    } catch (error) {
      debug.error(`Error sending file: ${filename}`, error);
      appuiToast.error(`Failed to send ${filename}: ${error.message}`, 5000);
      failCount++;

      // Mark file as failed in UI
      const fileItems = document.querySelectorAll('#file-list .file-item');
      const currentItem = fileItems[fileIndex];
      if (currentItem) {
        const statusElement = currentItem.querySelector('.file-status');
        if (statusElement) statusElement.textContent = '❌';
      }
    }
  }

  // All files processed - show appropriate message
  state.isTransferring = false;
  state.selectedFilePaths = [];

  if (buttons.sendFiles) {
    if (failCount === 0) {
      buttons.sendFiles.textContent = '✅ All Files Sent!';
      appuiToast.success(`All ${successCount} files sent successfully!`, 4000);
    } else if (successCount === 0) {
      buttons.sendFiles.textContent = '❌ All Failed';
      appuiToast.error(`Failed to send all ${failCount} files!`, 5000);
    } else {
      buttons.sendFiles.textContent = '⚠️ Partial Success';
      appuiToast.warn(`Sent ${successCount} files, ${failCount} failed`, 5000);
    }

    setTimeout(() => {
      buttons.sendFiles.textContent = '🚀 Send Files';
      buttons.sendFiles.disabled = false;
    }, 3000);
  }
}

// ============================================================================
// PROGRESS AND STATUS UPDATES
// ============================================================================

function updateFileProgress(progress) {
  let currentItem;

  if (state.currentMode === 'receiver') {
    const fileList = document.getElementById('received-files-list');
    currentItem = fileList.querySelector(`.file-item[data-file-number="${progress.currentFile}"]`);
  } else {
    const fileItems = document.querySelectorAll('#file-list .file-item');
    currentItem = fileItems[progress.currentFile - 1];
  }

  if (currentItem) {
    const fileNameElement = currentItem.querySelector('.file-name');
    const sizeElement = currentItem.querySelector('.file-size');
    const statusElement = currentItem.querySelector('.file-status');

    if (fileNameElement && progress.fileName && fileNameElement.textContent !== progress.fileName) {
      fileNameElement.textContent = progress.fileName;
      currentItem.dataset.fileName = progress.fileName;
    }

    const bytes = progress.sentBytes || progress.receivedBytes || 0;
    let statusText = `${formatFileSize(bytes)} / ${formatFileSize(progress.totalBytes)} (${progress.progress}%)`;
    
    // Add speed if available
    if (progress.speed && progress.speed > 0) {
      statusText += ` • ${formatFileSize(progress.speed)}/s`;
    }
    
    sizeElement.textContent = statusText;

    if (progress.progress === 100) {
      statusElement.textContent = state.currentMode === 'sender' ? '✅' : '⏳';
    } else {
      statusElement.textContent = state.currentMode === 'sender' ? '⬆️' : '⬇️';
    }
  } else {
    debug.warn(`[UPDATE] File item not found: ${progress.currentFile}`);
  }
}

// ============================================================================
// FILE PROGRESS & COMPLETION FUNCTIONS (GENERALIZED FOR LOCAL & REMOTE)
// ============================================================================

/**
 * Generalized function to create or ensure a file item exists in the receiver UI
 * Works for both local and remote transfers
 */
function ensureReceiverFileItem(progress) {
  const fileList = document.getElementById('received-files-list');
  let existingItem = fileList.querySelector(
    `.file-item[data-file-number="${progress.currentFile}"]`
  );

  if (!existingItem) {
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.dataset.fileNumber = progress.currentFile;
    fileItem.dataset.fileName = progress.fileName;
    fileItem.innerHTML = `
      <span class="file-icon">📄</span>
      <div class="file-info">
        <div class="file-name">${progress.fileName}</div>
        <div class="file-size">Receiving...</div>
      </div>
      <span class="file-status">⬇️</span>
    `;
    fileList.appendChild(fileItem);
    debug.log(`[RECEIVER] Created file item: ${progress.currentFile} - ${progress.fileName}`);
  } else {
    const fileNameElement = existingItem.querySelector('.file-name');
    if (fileNameElement && fileNameElement.textContent !== progress.fileName) {
      fileNameElement.textContent = progress.fileName;
      existingItem.dataset.fileName = progress.fileName;
      debug.log(`[RECEIVER] Updated file item: ${progress.currentFile}`);
    }
  }
}

/**
 * Generalized function to mark a received file as complete
 * Works for both local and remote transfers
 */
function finalizeReceivedFileUI(fileData) {
  const { 
    fileNumber, 
    fileName, 
    originalFileName = fileName,
    actualFileName = fileName,
    fileSize, 
    savePath 
  } = fileData;
  
  debug.log(`[FINALIZE] ${fileNumber}: ${fileName}`);
  
  const fileList = document.getElementById('received-files-list');
  const fileItem = fileList.querySelector(`.file-item[data-file-number="${fileNumber}"]`);

  if (fileItem) {
    const sizeElement = fileItem.querySelector('.file-size');
    const statusElement = fileItem.querySelector('.file-status');
    const fileNameElement = fileItem.querySelector('.file-name');
    
    // Update file size and save path
    if (sizeElement) {
      const displayPath = savePath || state.saveDirectory || 'Downloads folder';
      sizeElement.textContent = `${formatFileSize(fileSize)} - Saved to ${displayPath}`;
    }
    
    // Update status icon to complete
    if (statusElement) {
      statusElement.textContent = '✅';
    }
    
    // Update displayed file name if it was renamed
    if (fileNameElement && actualFileName !== originalFileName) {
      fileNameElement.textContent = actualFileName;
      fileNameElement.title = `Original: ${originalFileName}`;
    }
    
    // Show success toast
    const displayName = actualFileName !== originalFileName ? 
      `${actualFileName} (renamed from ${originalFileName})` : actualFileName;
    appuiToast.success(`${displayName} received successfully!`, 4000);
    
  } else {
    debug.error(`[FINALIZE] File item not found: ${fileNumber}`);
  }
}

// Legacy function for backward compatibility (local transfers)
function updateReceivedFileComplete(file) {
  debug.log(`[LOCAL] Received complete:`, file);
  finalizeReceivedFileUI({
    fileNumber: file.currentFile,
    fileName: file.fileName,
    fileSize: file.fileSize,
    savePath: file.savePath
  });
}

// Copy to clipboard
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetId = btn.getAttribute('data-copy');
    const text = document.getElementById(targetId).textContent;
    navigator.clipboard.writeText(text);
    btn.textContent = '✅ Copied!';
    setTimeout(() => {
      btn.textContent = '📋 Copy';
    }, 2000);
  });
});

// ============================================================================
// MODAL EVENT HANDLERS
// ============================================================================

window.addEventListener('click', async (event) => {
  for (const [key, modal] of Object.entries(modals)) {
    if (event.target === modal) {
      await handleModalClose(`${key}-modal`);
    }
  }
});

document.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    for (const [key, modal] of Object.entries(modals)) {
      if (modal.style.display === 'block') {
        await handleModalClose(`${key}-modal`);
      }
    }
  }
});

// ============================================================================
// UI COMPONENTS (Alert & Toast)
// ============================================================================

const appuiAlert = (() => {
  const overlay = document.getElementById('appui-alert-overlay');
  const titleEl = document.getElementById('appui-alert-title');
  const messageEl = document.getElementById('appui-alert-message');
  const buttonsEl = document.getElementById('appui-alert-buttons');
  const closeBtn = document.getElementById('appui-alert-close');

  function show({ title = 'Alert', message = '', confirm = false }) {
    overlay.classList.remove('appui-hidden');
    titleEl.textContent = title;
    messageEl.textContent = message;
    buttonsEl.innerHTML = '';

    return new Promise((resolve) => {
      const okBtn = document.createElement('button');
      okBtn.textContent = 'OK';
      okBtn.className = 'appui-btn-primary';
      okBtn.onclick = () => {
        hide();
        resolve(true);
      };
      buttonsEl.appendChild(okBtn);

      if (confirm) {
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'appui-btn-danger';
        cancelBtn.onclick = () => {
          hide();
          resolve(false);
        };
        buttonsEl.prepend(cancelBtn);
      }
    });
  }

  function hide() {
    overlay.classList.add('appui-hidden');
  }

  closeBtn.onclick = hide;
  overlay.onclick = (e) => {
    if (e.target === overlay) hide();
  };

  return { show };
})();

const appuiToast = (() => {
  const container = document.createElement('div');
  container.className = 'appui-toast-container';
  document.body.appendChild(container);

  function show(message, type = 'info', duration = 4000, options = {}) {
    const toast = document.createElement('div');
    toast.className = `appui-toast appui-toast-${type}`;

    let toastHTML = `<span class="appui-toast-message">${message}</span>`;
    if (options.actionText && options.onAction) {
      toastHTML += `<button class="appui-toast-action">${options.actionText}</button>`;
    }
    toastHTML += `<span class="appui-toast-close">&times;</span>`;
    toast.innerHTML = toastHTML;

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    const timeout = setTimeout(() => remove(toast), duration);

    const actionBtn = toast.querySelector('.appui-toast-action');
    if (actionBtn && options.onAction) {
      actionBtn.onclick = () => {
        clearTimeout(timeout);
        options.onAction();
        remove(toast);
      };
    }

    toast.querySelector('.appui-toast-close').onclick = () => {
      clearTimeout(timeout);
      remove(toast);
    };
  }

  function remove(toast) {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }

  return {
    success: (msg, d, options) => show(msg, 'success', d, options),
    error: (msg, d, options) => show(msg, 'error', d, options),
    warn: (msg, d, options) => show(msg, 'warn', d, options),
    info: (msg, d, options) => show(msg, 'info', d, options),
  };
})();

debug.log('File Transfer App initialized ✅');
