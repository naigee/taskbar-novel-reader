const { app, Tray, Menu, screen, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const pinyin = require('pinyin');

let tray; // 系统托盘图标对象
let contentWindow;// 任务栏窗口对象
let currentText = '点击开始阅读'; // 当前显示的文本内容
let currentIndex = 0; // 当前阅读进度索引
let novelContent = []; // 小说内容数组
let currentNovelFile = null; // 当前小说文件路径
let novelFiles = []; // 小说文件列表
let progressCache = {}; // 进度缓存
let isImporting = false; // 是否正在导入小说

const configPath = path.join(__dirname, 'config.json');

//加载阅读进度
function loadProgress(novelKey) {
    try {
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (novelKey && config.progress && config.progress[novelKey]) {
                return config.progress[novelKey];
            }
            return config.currentIndex || 0;
        }
    } catch (error) {
        //console.error('加载进度失败:', error.message);
    }
    return 0;
}

function saveProgress(novelKey) {
    try {
        let config = {};
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }

        if (!config.progress) {
            config.progress = {};
        }

        if (novelKey) {
            config.progress[novelKey] = currentIndex;
        } else {
            config.currentIndex = currentIndex;
        }

        config.timestamp = Date.now();
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        // console.log('已保存进度：', novelKey || 'default', '索引:', currentIndex);
    } catch (error) {
        // console.error('保存进度失败:', error.message);
    }
}

function loadNovel(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split(/[\n]+/).filter(line => line.trim().length > 0);

        novelContent = [];
        lines.forEach(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.length > 25) {
                for (let i = 0; i < trimmedLine.length; i += 25) {
                    novelContent.push(trimmedLine.substring(i, i + 25));
                }
            } else if (trimmedLine.length > 0) {
                novelContent.push(trimmedLine);
            }
        });

        if (novelContent.length > 0) {
            const novelKey = path.basename(filePath, '.txt');
            currentIndex = loadProgress(novelKey);

            if (currentIndex >= novelContent.length) {
                currentIndex = 0;
            }

            currentText = novelContent[currentIndex];
            currentNovelFile = filePath;
            // console.log('加载小说:', novelKey, '共', novelContent.length, '行，从第', currentIndex + 1, '行开始');
        }
    } catch (error) {
        // console.error('加载小说失败:', error.message);
    }
}

function convertPinyinToZh(pinyinStr) {
    try {
        const result = pinyin(pinyinStr, {
            style: pinyin.STYLE_NORMAL,
            heteronym: false
        });

        const converted = result.map(item => item[0]).join('');
        return converted || pinyinStr;
    } catch (error) {
        // console.log('拼音转换失败:', pinyinStr, '使用原文件名');
        return pinyinStr;
    }
}

function scanNovelFolder() {
    // 适配开发环境和打包后的路径
    let novelFolderPath;

    // 在开发环境中，__dirname 指向项目根目录
    // 需要向上一级查找
    if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
        novelFolderPath = path.join(__dirname, 'novel');
    } else if (process.resourcesPath) {
        // 打包后的环境
        novelFolderPath = path.join(process.resourcesPath, 'novel');
    } else {
        // 默认情况
        novelFolderPath = path.join(__dirname, 'novel');
    }

    const files = [];

    try {
        if (fs.existsSync(novelFolderPath) && fs.statSync(novelFolderPath).isDirectory()) {
            const allFiles = fs.readdirSync(novelFolderPath);

            allFiles.forEach(file => {
                if (file.endsWith('.txt')) {
                    const filePath = path.join(novelFolderPath, file);
                    const fileName = path.basename(file, '.txt');

                    files.push({
                        path: filePath,
                        fileName: fileName,
                        displayName: fileName
                    });
                }
            });

            files.sort((a, b) => a.fileName.localeCompare(b.fileName));
        }
    } catch (error) {
        // console.error('扫描 novel 文件夹失败:', error.message, '路径:', novelFolderPath);
    }

    return files;
}

function createTrayMenu() {
    const menuItems = [];

    novelFiles.forEach((novel, index) => {
        menuItems.push({
            label: novel.displayName,
            type: 'radio',
            checked: currentNovelFile === novel.path,
            click: () => {
                if (currentNovelFile !== novel.path) {
                    if (currentNovelFile) {
                        const oldKey = path.basename(currentNovelFile, '.txt');
                        saveProgress(oldKey);
                    }

                    loadNovel(novel.path);
                    updateTrayTooltip();

                    if (contentWindow && !contentWindow.isDestroyed()) {
                        contentWindow.webContents.send('update-content', currentText);
                    }

                    rebuildTrayMenu();
                }
            }
        });
    });

    menuItems.push(
        { type: 'separator' },
        {
            label: '📥 导入新小说',
            click: async () => {
                if (isImporting) return;
                isImporting = true;

                try {
                    const result = await dialog.showOpenDialog(contentWindow, {
                        properties: ['openFile'],
                        filters: [
                            { name: 'TXT 文件', extensions: ['txt'] }
                        ],
                        title: '选择要导入的小说文件'
                    });

                    if (!result.canceled && result.filePaths.length > 0) {
                        const sourcePath = result.filePaths[0];
                        const fileName = path.basename(sourcePath);
                        const destPath = path.join(__dirname, 'novel', fileName);

                        // 检查是否已存在
                        if (fs.existsSync(destPath)) {
                            const confirmResult = await dialog.showMessageBox(contentWindow, {
                                type: 'question',
                                buttons: ['覆盖', '取消'],
                                defaultId: 1,
                                title: '文件已存在',
                                message: `小说"${fileName}"已存在，是否覆盖？`,
                            });

                            if (confirmResult.response === 0) {
                                fs.copyFileSync(sourcePath, destPath);
                                await reloadNovelsAfterImport();
                            }
                        } else {
                            fs.copyFileSync(sourcePath, destPath);
                            await reloadNovelsAfterImport();
                        }
                    }
                } catch (error) {
                    console.error('导入小说失败:', error);
                    dialog.showErrorBox('导入失败', '导入小说时发生错误：' + error.message);
                } finally {
                    isImporting = false;
                }
            }
        },
        {
            label: '📂 打开小说文件夹',
            click: () => {
                const novelFolderPath = path.join(__dirname, 'novel');
                if (fs.existsSync(novelFolderPath)) {
                    shell.openPath(novelFolderPath);
                } else {
                    fs.mkdirSync(novelFolderPath, { recursive: true });
                    shell.openPath(novelFolderPath);
                }
                // 重要：打开文件夹后，提醒用户需要手动刷新
                dialog.showMessageBox(contentWindow, {
                    type: 'info',
                    title: '已打开小说文件夹',
                    message: '请将小说文件复制到此文件夹',
                    detail: '复制完成后，再次右键点击托盘图标，选择"🔄 刷新小说列表"菜单项',
                    buttons: ['知道了']
                });
            }
        },
        {
            label: '🔄 刷新小说列表',
            click: () => {
                refreshNovelList(true);
            }
        },
        { type: 'separator' },
        {
            label: '重置当前进度',
            click: () => {
                if (currentNovelFile) {
                    currentIndex = 0;
                    currentText = novelContent[0] || '点击开始阅读';
                    const novelKey = path.basename(currentNovelFile, '.txt');
                    saveProgress(novelKey);
                    if (contentWindow && !contentWindow.isDestroyed()) {
                        contentWindow.webContents.send('update-content', currentText);
                    }
                    updateTrayTooltip();
                }
            }
        },
        { type: 'separator' },
        {
            label: '退出',
            click: () => {
                if (currentNovelFile) {
                    const novelKey = path.basename(currentNovelFile, '.txt');
                    saveProgress(novelKey);
                }

                if (contentWindow && !contentWindow.isDestroyed()) {
                    contentWindow.destroy();
                    contentWindow = null;
                }

                if (tray) {
                    tray.destroy();
                    tray = null;
                }

                app.quit();
            }
        }
    );

    return Menu.buildFromTemplate(menuItems);
}

async function reloadNovelsAfterImport() {
    // 重新扫描小说文件夹
    novelFiles = scanNovelFolder();

    // 重建托盘菜单
    rebuildTrayMenu();

    // 显示成功提示
    dialog.showMessageBox(contentWindow, {
        type: 'info',
        title: '导入成功',
        message: `已成功导入 ${novelFiles.length} 本小说`,
        detail: '可以在右键菜单中切换小说',
        buttons: ['确定']
    });
}

// 手动刷新小说列表
function refreshNovelList(showNotification = true) {
    novelFiles = scanNovelFolder();
    rebuildTrayMenu();

    // console.log('手动刷新小说列表:', novelFiles.map(f => `${f.fileName} -> ${f.displayName}`));

    if (showNotification) {
        dialog.showMessageBox(contentWindow, {
            type: 'info',
            title: '刷新完成',
            message: `当前共有 ${novelFiles.length} 本小说`,
            detail: novelFiles.map(f => `• ${f.displayName}`).join('\n'),
            buttons: ['确定']
        });
    }
}

function rebuildTrayMenu() {
    if (tray) {
        tray.setContextMenu(createTrayMenu());
    }
}

function updateTrayTooltip() {
    if (tray) {
        tray.setToolTip(currentText);
    }
}
//下一行
function showNextLine() {
    if (novelContent.length === 0) {
        currentText = '暂无内容';
        if (contentWindow && !contentWindow.isDestroyed()) {
            contentWindow.webContents.send('update-content', currentText);
        }
        return;
    }

    currentIndex = (currentIndex + 1) % novelContent.length;
    currentText = novelContent[currentIndex];

    if (contentWindow && !contentWindow.isDestroyed()) {
        contentWindow.webContents.send('update-content', currentText);
    }

    // 每次切换后自动保存进度
    saveProgress();
}
//上一行
function showPrevLine() {
    if (novelContent.length === 0) {
        return;
    }

    currentIndex = (currentIndex - 1 + novelContent.length) % novelContent.length;
    currentText = novelContent[currentIndex];

    if (contentWindow && !contentWindow.isDestroyed()) {
        contentWindow.webContents.send('update-content', currentText);
    }
    saveProgress();
}

// 在 app.whenReady 中添加监听
ipcMain.on('prev-line', () => {
    showPrevLine();
});

function createContentWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    const windowWidth = 300;
    const windowHeight = 40;

    const x = (width - windowWidth) / 2 + 200;
    const y = height - windowHeight + 40;

    contentWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        x: x,
        y: y,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        focusable: true,
        hasShadow: false,
        show: true,
        visibleOnAllWorkspaces: true,
        type: 'toolbar',  // 设置为工具栏类型，更不容易被隐藏
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // 关键修复：设置窗口层级为最高（屏幕保护级别）
    contentWindow.setAlwaysOnTop(true, 'screen-saver');

    // 确保窗口在所有工作区可见
    contentWindow.setVisibleOnAllWorkspaces(true);

    // 防止窗口失去焦点时隐藏
    contentWindow.setIgnoreMouseEvents(false);

    // 重要：禁止窗口隐藏
    contentWindow.on('hide', (e) => {
        e.preventDefault();
        contentWindow.show();
        contentWindow.setAlwaysOnTop(true, 'screen-saver');
    });

    // 监听窗口最小化事件并阻止
    contentWindow.on('minimize', (e) => {
        e.preventDefault();
        contentWindow.restore();
        contentWindow.show();
    });

    // 确保窗口始终保持显示
    contentWindow.on('blur', () => {
        setTimeout(() => {
            if (contentWindow && !contentWindow.isDestroyed()) {
                contentWindow.setAlwaysOnTop(true, 'screen-saver');
                contentWindow.setVisibleOnAllWorkspaces(true);
                contentWindow.show();
            }
        }, 100);
    });

    // 监听显示桌面后的恢复
    contentWindow.on('show', () => {
        if (contentWindow && !contentWindow.isDestroyed()) {
            contentWindow.setAlwaysOnTop(true, 'screen-saver');
            contentWindow.setVisibleOnAllWorkspaces(true);
        }
    });

    contentWindow.loadFile('index.html');

    contentWindow.webContents.on('did-finish-load', () => {
        contentWindow.webContents.send('update-content', currentText);
        contentWindow.show();
        contentWindow.focus();
        contentWindow.setAlwaysOnTop(true, 'screen-saver');
        contentWindow.setVisibleOnAllWorkspaces(true);
    });

    contentWindow.on('closed', () => {
        contentWindow = null;
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.png');

    if (!fs.existsSync(iconPath)) {
        // console.warn('图标文件不存在');
        return false;
    }

    tray = new Tray(iconPath);

    novelFiles = scanNovelFolder();

    //console.log('扫描到的小说文件:', novelFiles.map(f => `${f.fileName} -> ${f.displayName}`));

    if (novelFiles.length > 0) {
        loadNovel(novelFiles[0].path);
    }

    tray.setContextMenu(createTrayMenu());

    updateTrayTooltip();

    tray.on('click', () => {
        // 点击托盘图标时，确保窗口显示并置顶
        if (contentWindow && !contentWindow.isDestroyed()) {
            contentWindow.show();
            contentWindow.focus();
            contentWindow.setAlwaysOnTop(true, 'screen-saver');
            contentWindow.setVisibleOnAllWorkspaces(true);

            // 确保窗口可见
            setTimeout(() => {
                if (contentWindow && !contentWindow.isDestroyed()) {
                    contentWindow.show();
                    contentWindow.setAlwaysOnTop(true, 'screen-saver');
                }
            }, 100);
        }
    });

    // 监听鼠标悬停
    tray.on('balloon-show', () => {
        if (contentWindow && !contentWindow.isDestroyed()) {
            contentWindow.show();
        }
    });

    return true;
}

app.whenReady().then(() => {
    const novelFolderPath = path.join(__dirname, 'novel');
    if (fs.existsSync(novelFolderPath) && fs.statSync(novelFolderPath).isDirectory()) {
        // novel 文件夹存在，createTray 会自动扫描
    }
    createContentWindow();

    const trayCreated = createTray();
    if (trayCreated) {
        // console.log('应用启动完成');
    }

    ipcMain.on('next-line', () => {
        showNextLine();
    });

    // 处理拖拽导入
    ipcMain.handle('import-novel', async (event, filePath) => {
        if (isImporting || !filePath) return;
        isImporting = true;

        try {
            const fileName = path.basename(filePath);
            const destPath = path.join(__dirname, 'novel', fileName);

            if (fs.existsSync(destPath)) {
                const confirmResult = await dialog.showMessageBox(contentWindow, {
                    type: 'question',
                    buttons: ['覆盖', '取消'],
                    defaultId: 1,
                    title: '文件已存在',
                    message: `小说"${fileName}"已存在，是否覆盖？`,
                });

                if (confirmResult.response === 0) {
                    fs.copyFileSync(filePath, destPath);
                    await reloadNovelsAfterImport();
                    return { success: true };
                }
            } else {
                fs.copyFileSync(filePath, destPath);
                await reloadNovelsAfterImport();
                return { success: true };
            }
        } catch (error) {
            console.error('导入小说失败:', error);
            return { success: false, error: error.message };
        } finally {
            isImporting = false;
        }
    });
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
    if (currentNovelFile) {
        const novelKey = path.basename(currentNovelFile, '.txt');
        saveProgress(novelKey);
        // console.log('窗口关闭，保存进度:', novelKey);
    }

    if (tray) {
        tray.destroy();
        tray = null;
    }

    if (contentWindow && !contentWindow.isDestroyed()) {
        contentWindow.destroy();
        contentWindow = null;
    }

    app.quit();
});

app.on('before-quit', () => {
    if (currentNovelFile) {
        const novelKey = path.basename(currentNovelFile, '.txt');
        saveProgress(novelKey);
        // console.log('应用退出，保存进度:', novelKey);
    }
});