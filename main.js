const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow = null;
let httpServer = null;

async function bootstrap() {
  // Set data file path to user data directory (persists across installs)
  const userDataPath = app.getPath('userData');
  const dataFile = path.join(userDataPath, 'data.json');
  process.env.DATA_FILE = dataFile;

  // Migrate existing data on first run
  if (!fs.existsSync(dataFile)) {
    const oldDataFile = path.join(__dirname, 'data.json');
    if (fs.existsSync(oldDataFile)) {
      fs.copyFileSync(oldDataFile, dataFile);
      console.log('Migrated existing data.json to user data directory');
    }
  }

  // Start the Express server (inside Electron process)
  const { start } = require('./server');
  const { server, port } = await start(3456);
  httpServer = server;
  console.log(`Server started on port ${port}`);

  // Create the main window
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Agent Dev Platform',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Load the app
  mainWindow.loadURL(`http://localhost:${port}`);

  // Open external links in the system browser; allow localhost popups (standalone chat window)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost') || url.startsWith('https://localhost')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1024,
          height: 760,
          minWidth: 720,
          minHeight: 520,
          backgroundColor: '#0d1117',
          autoHideMenuBar: true,
          title: '对话窗口'
        }
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    bootstrap();
  }
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
