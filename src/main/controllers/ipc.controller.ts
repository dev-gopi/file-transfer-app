/**
 * IPC Controller for file transfer operations
 * Handles all inter-process communication between renderer and main process
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getLocalIPAddress } from '../lib/network.lib';
import { LocalFileTransferService } from '../services/localFileTransfer.service';
import RemoteFileTransferService from '../services/remoteFileTransfer.service';
import { IPC_CHANNELS } from '../utils/constants';
import { getUniqueFileName } from '../utils/fileHelper';
import { logger } from '../utils/logger';

let localTransferService: LocalFileTransferService | null = null;
let remoteTransferService: RemoteFileTransferService | null = null;

/**
 * Setup all IPC handlers
 */
export function setupIPCHandlers(mainWindow: BrowserWindow): void {
  localTransferService = new LocalFileTransferService(mainWindow);
  remoteTransferService = new RemoteFileTransferService(mainWindow);

  // Start sender mode
  ipcMain.handle(IPC_CHANNELS.START_SENDER, async (_event, transferType?: string) => {
    try {
      logger.loading('Starting sender mode...', transferType);
      if (transferType?.trim() === 'remote') {
        const result = await remoteTransferService!.startSender();
        logger.success('Remote sender mode started successfully');
        return result; // Remote mode doesn't provide IP/port/code
      } else {
        const result = await localTransferService!.startSender();
        logger.success('Sender mode started successfully');
        return result;
      }
    } catch (err) {
      const error = err as Error;
      logger.error('Failed to start sender:', error.message);
      throw err;
    }
  });

  // Read file as buffer (for remote transfer)
  ipcMain.handle(IPC_CHANNELS.READ_FILE_AS_BUFFER, (_event, filePath: string) => {
    try {
      const buffer = fs.readFileSync(filePath);
      logger.success(`Read file as buffer: ${path.basename(filePath)}`);
      return buffer;
    } catch (err) {
      const error = err as Error;
      logger.error(`Failed to read file ${filePath}:`, error.message);
      throw err;
    }
  });

  // Read file chunk (for streaming remote transfer)
  ipcMain.handle(
    IPC_CHANNELS.READ_FILE_CHUNK,
    (_event, filePath: string, offset: number, length: number) => {
      try {
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
        fs.closeSync(fd);

        return {
          chunk: buffer.slice(0, bytesRead),
          bytesRead: bytesRead,
          hasMore: bytesRead === length,
        };
      } catch (err) {
        const error = err as Error;
        logger.error(`Failed to read file chunk ${filePath}:`, error.message);
        throw err;
      }
    }
  );

  // Get file size
  ipcMain.handle(IPC_CHANNELS.GET_FILE_SIZE, (_event, filePath: string) => {
    try {
      const stats = fs.statSync(filePath);
      return stats.size;
    } catch (err) {
      const error = err as Error;
      logger.error(`Failed to get file size ${filePath}:`, error.message);
      throw err;
    }
  });

  // Save received file (for remote transfer - small files)
  ipcMain.handle(
    IPC_CHANNELS.SAVE_RECEIVED_FILE,
    (_event, fileName: string, buffer: Uint8Array, saveDir?: string) => {
      try {
        const savePath = saveDir || app.getPath('downloads');
        
        // Get unique file name if file already exists
        const uniqueFileName = getUniqueFileName(fileName, savePath);
        const fullPath = path.join(savePath, uniqueFileName);

        // Ensure directory exists
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Write file to disk
        fs.writeFileSync(fullPath, Buffer.from(buffer));
        logger.success(`Received file saved: ${uniqueFileName} (original: ${fileName})`);

        return { success: true, path: fullPath, fileName: uniqueFileName };
      } catch (err) {
        const error = err as Error;
        logger.error(`Failed to save received file ${fileName}:`, error.message);
        throw err;
      }
    }
  );

  // Initialize file stream for large file transfers
  ipcMain.handle(IPC_CHANNELS.INIT_FILE_STREAM, (_event, fileName: string, saveDir?: string) => {
    try {
      const savePath = saveDir || app.getPath('downloads');
      
      // Get unique file name if file already exists
      const uniqueFileName = getUniqueFileName(fileName, savePath);
      const fullPath = path.join(savePath, uniqueFileName);

      // Ensure directory exists
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Create empty file
      fs.writeFileSync(fullPath, Buffer.alloc(0));
      logger.info(`Initialized file stream: ${uniqueFileName} (original: ${fileName})`);

      return { success: true, path: fullPath, fileName: uniqueFileName };
    } catch (err) {
      const error = err as Error;
      logger.error(`Failed to initialize file stream ${fileName}:`, error.message);
      throw err;
    }
  });

  // Append chunk to file stream
  ipcMain.handle(
    IPC_CHANNELS.APPEND_FILE_CHUNK,
    (_event, fileName: string, chunk: Uint8Array, saveDir?: string) => {
      try {
        const savePath = saveDir || app.getPath('downloads');
        const fullPath = path.join(savePath, fileName);

        // Append chunk to file
        fs.appendFileSync(fullPath, Buffer.from(chunk));

        return { success: true };
      } catch (err) {
        const error = err as Error;
        logger.error(`Failed to append chunk to ${fileName}:`, error.message);
        throw err;
      }
    }
  );

  // Finalize file stream
  ipcMain.handle(IPC_CHANNELS.FINALIZE_FILE, (_event, fileName: string, saveDir?: string) => {
    try {
      const savePath = saveDir || app.getPath('downloads');
      const fullPath = path.join(savePath, fileName);

      logger.success(`File transfer complete: ${fileName}`);

      return { success: true, path: fullPath };
    } catch (err) {
      const error = err as Error;
      logger.error(`Failed to finalize file ${fileName}:`, error.message);
      throw err;
    }
  });

  // Stop sender mode
  ipcMain.handle(IPC_CHANNELS.STOP_SENDER, async (_event, transferType?: string) => {
    try {
      if (transferType?.trim() === 'remote') {
        await remoteTransferService!.stopSender();
      } else {
        localTransferService!.stopSender();
      }
      return { success: true };
    } catch (err) {
      const error = err as Error;
      logger.error('Failed to stop sender:', error.message);
      throw err;
    }
  });

  // Connect to sender as receiver
  ipcMain.handle(
    IPC_CHANNELS.CONNECT_RECEIVER,
    async (_event, ip: string, port: number, code: string, saveDir?: string) => {
      try {
        logger.loading(`Connecting to sender at ${ip}:${port}...`);

        let finalSaveDir = saveDir;

        // Only ask for folder if not provided
        if (!finalSaveDir) {
          const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: 'Select folder to save received files',
          });

          if (result.canceled || result.filePaths.length === 0) {
            throw new Error('No save location selected');
          }

          finalSaveDir = result.filePaths[0];
        }

        await localTransferService!.connectToSender(ip, port, code, finalSaveDir);

        return { success: true, saveDir: finalSaveDir };
      } catch (err) {
        const error = err as Error;
        logger.error('Failed to connect to sender:', error.message);
        throw err;
      }
    }
  );

  // Disconnect receiver
  ipcMain.handle(IPC_CHANNELS.DISCONNECT_RECEIVER, () => {
    try {
      if (localTransferService) {
        localTransferService.disconnectReceiver();
      }
      return { success: true };
    } catch (err) {
      const error = err as Error;
      logger.error('Failed to disconnect receiver:', error.message);
      throw err;
    }
  });

  // Send files
  ipcMain.handle(IPC_CHANNELS.SEND_FILES, async (_event, filePaths: string[]) => {
    try {
      logger.loading('Preparing to send files...');
      await localTransferService!.sendFiles(filePaths);
      return { success: true };
    } catch (err) {
      const error = err as Error;
      logger.error('Failed to send files:', error.message);
      throw err;
    }
  });

  // Select files to send
  ipcMain.handle(IPC_CHANNELS.SELECT_FILES, async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        title: 'Select files to transfer',
      });

      if (result.canceled) {
        return { canceled: true, filePaths: [] };
      }

      return { canceled: false, filePaths: result.filePaths };
    } catch (err) {
      const error = err as Error;
      logger.error('Failed to select files:', error.message);
      throw err;
    }
  });

  // Select folder for saving
  ipcMain.handle(IPC_CHANNELS.SELECT_SAVE_DIR, async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select folder to save files',
      });

      if (result.canceled) {
        return { canceled: true, folderPath: '' };
      }

      return { canceled: false, folderPath: result.filePaths[0] };
    } catch (err) {
      const error = err as Error;
      logger.error('Failed to select folder:', error.message);
      throw err;
    }
  });

  // Read file - returns stream URLs (for media playback)
  ipcMain.handle(IPC_CHANNELS.READ_FILE, (_event, filePaths: string[]) => {
    try {
      const streamUrls = filePaths.map((filePath) => {
        return `app://stream${encodeURIComponent(filePath)}`;
      });

      return streamUrls;
    } catch (err) {
      const error = err as Error;
      logger.error('Failed to get stream URL for file URLs:', error.message);
      throw err;
    }
  });

  // Get local IP address
  ipcMain.handle(IPC_CHANNELS.GET_LOCAL_IP, () => {
    try {
      const ip = getLocalIPAddress();

      return ip;
    } catch (err) {
      const error = err as Error;
      logger.error('Failed to get local IP:', error.message);
      return 'localhost';
    }
  });

  // Discover file transfer services on network
  ipcMain.handle(IPC_CHANNELS.DISCOVER_SERVICES, async (): Promise<unknown[]> => {
    try {
      logger.loading('Discovering file transfer services on network...');
      const services = await localTransferService!.discoverServices();
      logger.success(`Found ${services.length} service(s)`);
      return services;
    } catch (err) {
      const error = err as Error;
      logger.error('Failed to discover services:', error.message);
      logger.error('Stack trace:', error.stack);
      throw err; // Throw the error so the client can see it
    }
  });

  logger.success('IPC handlers registered successfully');
}

/**
 * Cleanup IPC handlers
 */
export function cleanupIPCHandlers(): void {
  if (localTransferService) {
    localTransferService.cleanup();
    localTransferService = null;
  }
  if (remoteTransferService) {
    remoteTransferService.cleanup();
    remoteTransferService = null;
  }

  // Remove all IPC handlers
  Object.values(IPC_CHANNELS).forEach((channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners(channel);
  });

  logger.info('IPC handlers cleaned up');
}
