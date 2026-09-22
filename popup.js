// 极简书签弹窗 popup.js - 忠实还原 Popup my Bookmarks (PmB) 交互

const DEFAULT_SETTINGS = {
  panelWidth: 230,
  popupHeight: 520,
  itemHeight: 22,
  fontSize: 12,
  openTarget: 'current', // 'current' | 'new-active' | 'new-bg'
  hoverDelay: 80, // 0 | 80 | 160 | -1 (click only)
  showOtherBookmarks: true,
  prettifySeparators: true
};

let userSettings = { ...DEFAULT_SETTINGS };

async function loadUserSettings() {
  try {
    if (chrome.storage && chrome.storage.sync) {
      const stored = await chrome.storage.sync.get('quick_bookmarks_settings');
      if (stored && stored.quick_bookmarks_settings) {
        userSettings = { ...DEFAULT_SETTINGS, ...stored.quick_bookmarks_settings };
      }
    } else {
      const local = localStorage.getItem('quick_bookmarks_settings');
      if (local) userSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(local) };
    }
  } catch (e) {
    console.warn('加载设置失败，使用默认配置', e);
  }
  applySettingsToUI();
}

function applySettingsToUI() {
  const root = document.documentElement;
  root.style.setProperty('--panel-width', `${userSettings.panelWidth}px`);
  root.style.setProperty('--popup-height', `${userSettings.popupHeight}px`);
  root.style.setProperty('--item-height', `${userSettings.itemHeight}px`);
  root.style.setProperty('--app-font-size', `${userSettings.fontSize}px`);
}

async function saveUserSettings(newSettings) {
  userSettings = { ...newSettings };
  applySettingsToUI();
  try {
    if (chrome.storage && chrome.storage.sync) {
      await chrome.storage.sync.set({ 'quick_bookmarks_settings': userSettings });
    } else {
      localStorage.setItem('quick_bookmarks_settings', JSON.stringify(userSettings));
    }
  } catch (e) {}
  loadBookmarkTree();
}

// ----------------------------------------------------
// 鼠标斜向移动防误触算法 (Menu Aim Safe Triangle)
// ----------------------------------------------------
const mouseHistory = [];

document.addEventListener('mousemove', (e) => {
  const now = Date.now();
  mouseHistory.push({ x: e.clientX, y: e.clientY, time: now });
  // 只保留最近 200ms 内的轨迹
  while (mouseHistory.length > 0 && now - mouseHistory[0].time > 200) {
    mouseHistory.shift();
  }
  // 鼠标移动时清理键盘遗留的蓝色高亮框
  if (keyboardFocusedEl) {
    clearKeyboardFocus();
  }
});

// 鼠标移出浏览器弹窗时清理焦点框
document.addEventListener('mouseleave', () => {
  clearKeyboardFocus();
});

window.addEventListener('blur', () => {
  clearKeyboardFocus();
});

function isPointInTriangle(p, a, b, c) {
  const v0 = [c.x - a.x, c.y - a.y];
  const v1 = [b.x - a.x, b.y - a.y];
  const v2 = [p.x - a.x, p.y - a.y];

  const dot00 = v0[0] * v0[0] + v0[1] * v0[1];
  const dot01 = v0[0] * v1[0] + v0[1] * v1[1];
  const dot02 = v0[0] * v2[0] + v0[1] * v2[1];
  const dot11 = v1[0] * v1[0] + v1[1] * v1[1];
  const dot12 = v1[0] * v2[0] + v1[1] * v2[1];

  const denom = (dot00 * dot11 - dot01 * dot01);
  if (denom === 0) return false;
  const invDenom = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

  return (u >= 0) && (v >= 0) && (u + v <= 1);
}

function isMouseMovingToSubmenu(depth) {
  if (mouseHistory.length < 2) return false;
  const childPanel = panelsContainer.querySelector(`.pmb-panel[data-depth="${depth + 1}"]`);
  if (!childPanel) return false;

  const currentLoc = mouseHistory[mouseHistory.length - 1];
  const prevLoc = mouseHistory[0];

  const dx = currentLoc.x - prevLoc.x;
  const dy = currentLoc.y - prevLoc.y;

  // 必须有明确的向左移动 (dx <= -2)，如果是垂直移动或向右移动则不是去子菜单
  if (dx > -2) return false;
  if (Math.abs(dy) > Math.abs(dx) * 2.5) return false;

  const childRect = childPanel.getBoundingClientRect();
  const offset = 15; // 边缘容差
  const p1 = prevLoc;
  const p2 = { x: childRect.right, y: childRect.top - offset };
  const p3 = { x: childRect.right, y: childRect.bottom + offset };

  return isPointInTriangle(currentLoc, p1, p2, p3);
}

let bookmarkTreeData = [];
let bookmarkBarNode = null;
let currentViewMode = localStorage.getItem('bookmark_view_mode_') || 'cascade'; // 'cascade' | 'tree'
let expandedFolders = new Set(JSON.parse(localStorage.getItem('expanded_folders_') || '[]'));
let activeContextMenuTarget = null;
let activeContextMenuType = null;
let modalCallback = null;

// 防抖与延迟定时器
let hoverOpenTimer = null;
let hoverCloseTimer = null;
let openCascadeFolderIds = []; // 记录当前各级展开的文件夹ID链
let lastCreatedBookmarkId = null; // 记录最新创建的项ID以高亮提示

// 正在搜索状态标志
let isSearching = false;

// 统一书签打开逻辑
function openBookmarkUrl(url, isBackground = false) {
  if (!url) return;
  if (isBackground) {
    chrome.tabs.create({ url, active: false });
    return;
  }
  if (userSettings.openTarget === 'new-bg') {
    chrome.tabs.create({ url, active: false });
  } else if (userSettings.openTarget === 'new-active') {
    chrome.tabs.create({ url, active: true });
    window.close();
  } else {
    chrome.tabs.update({ url });
    window.close();
  }
}

// ----------------------------------------------------
// 全键盘极速导航管理器 (Keyboard Navigator)
// ----------------------------------------------------
let keyboardFocusedEl = null;

function setKeyboardFocus(el, scroll = true) {
  if (keyboardFocusedEl && keyboardFocusedEl !== el) {
    keyboardFocusedEl.classList.remove('keyboard-focused');
  }
  keyboardFocusedEl = el;
  if (keyboardFocusedEl) {
    keyboardFocusedEl.classList.add('keyboard-focused');
    if (scroll) {
      keyboardFocusedEl.scrollIntoView({ block: 'nearest' });
    }
  }
}

function clearKeyboardFocus() {
  if (keyboardFocusedEl) {
    keyboardFocusedEl.classList.remove('keyboard-focused');
    keyboardFocusedEl = null;
  }
}

function getActiveNavigationItems() {
  if (currentViewMode === 'tree') {
    const treeInput = document.getElementById('tree-search-input');
    if (treeInput && treeInput.value.trim()) {
      return Array.from(treeList.querySelectorAll('.search-item'));
    }
    return Array.from(treeList.querySelectorAll('.node-row')).filter(el => el.offsetParent !== null);
  }

  // 级联模式
  if (isSearching) {
    const rootList = document.getElementById('root-panel-list');
    return rootList ? Array.from(rootList.querySelectorAll('.search-item')) : [];
  }

  // 级联常态：优先当前 focusedEl 所在面板，否则取最右侧面板
  let targetPanel = null;
  if (keyboardFocusedEl && keyboardFocusedEl.closest('.pmb-panel')) {
    targetPanel = keyboardFocusedEl.closest('.pmb-panel');
  } else {
    const panels = Array.from(panelsContainer.querySelectorAll('.pmb-panel'));
    if (panels.length > 0) {
      targetPanel = panels[panels.length - 1];
    }
  }

  if (!targetPanel) return [];
  return Array.from(targetPanel.querySelectorAll('.pmb-item:not(.is-separator):not(.is-section-separator)'));
}

function triggerItemAction(el, isCtrlOrCmd = false) {
  if (!el) return;

  // 1. 搜索项
  if (el.classList.contains('search-item')) {
    const url = el.title || el.querySelector('.search-item-url')?.textContent;
    if (url) {
      openBookmarkUrl(url, isCtrlOrCmd);
    }
    return;
  }

  // 2. 级联模式项
  if (el.classList.contains('pmb-item')) {
    const isFolder = Boolean(el.querySelector('.folder-svg') || el.querySelector('.item-arrow'));
    if (isFolder) {
      const currentPanel = el.closest('.pmb-panel');
      const depth = parseInt(currentPanel?.dataset?.depth || '0', 10);
      el.click();
      setTimeout(() => {
        const nextPanel = panelsContainer.querySelector(`.pmb-panel[data-depth="${depth + 1}"]`);
        if (nextPanel) {
          const firstItem = nextPanel.querySelector('.pmb-item:not(.is-separator):not(.is-section-separator)');
          if (firstItem) {
            setKeyboardFocus(firstItem);
          }
        }
      }, 60);
    } else {
      if (isCtrlOrCmd) {
        const fakeEvent = new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true });
        el.dispatchEvent(fakeEvent);
      } else {
        el.click();
      }
    }
    return;
  }

  // 3. 树状模式节点行
  if (el.classList.contains('node-row')) {
    const isFolder = Boolean(el.querySelector('.toggle-arrow'));
    if (isFolder) {
      el.click();
    } else {
      if (isCtrlOrCmd) {
        const fakeEvent = new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true });
        el.dispatchEvent(fakeEvent);
      } else {
        el.click();
      }
    }
  }
}

function handleNavigateLeft() {
  if (currentViewMode === 'tree') {
    if (!keyboardFocusedEl) return;
    const nodeEl = keyboardFocusedEl.closest('.tree-node');
    const childrenContainer = nodeEl?.querySelector('.node-children');
    const arrow = keyboardFocusedEl.querySelector('.toggle-arrow');
    if (childrenContainer && !childrenContainer.classList.contains('hidden')) {
      arrow?.click();
    } else {
      const parentNode = nodeEl?.parentElement?.closest('.tree-node');
      const parentRow = parentNode?.querySelector(':scope > .node-row');
      if (parentRow) {
        setKeyboardFocus(parentRow);
      }
    }
    return;
  }

  // 级联模式 (从右往左弹出，箭头为 ‹):
  // 按 ← (向左键): 顺着箭头方向展开文件夹，进入左侧子面板！
  if (!keyboardFocusedEl) return;
  const isFolder = Boolean(keyboardFocusedEl.querySelector('.folder-svg') || keyboardFocusedEl.querySelector('.item-arrow'));
  if (isFolder) {
    triggerItemAction(keyboardFocusedEl);
  }
}

function handleNavigateRight() {
  if (currentViewMode === 'tree') {
    if (!keyboardFocusedEl) return;
    const nodeEl = keyboardFocusedEl.closest('.tree-node');
    const childrenContainer = nodeEl?.querySelector('.node-children');
    const arrow = keyboardFocusedEl.querySelector('.toggle-arrow');
    if (childrenContainer && childrenContainer.classList.contains('hidden')) {
      arrow?.click();
    }
    return;
  }

  // 级联模式 (从右往左弹出):
  // 按 → (向右键): 关闭当前子面板，退回右侧父级面板！
  if (!keyboardFocusedEl) return;
  const currentPanel = keyboardFocusedEl.closest('.pmb-panel');
  if (!currentPanel) return;
  const depth = parseInt(currentPanel.dataset.depth || '0', 10);

  if (depth > 0) {
    const closeBtn = currentPanel.querySelector('.h-btn-close');
    if (closeBtn) {
      closeBtn.click();
    } else {
      currentPanel.remove();
    }
    const parentPanel = panelsContainer.querySelector(`.pmb-panel[data-depth="${depth - 1}"]`);
    if (parentPanel) {
      const activeItem = parentPanel.querySelector('.pmb-item.active') || parentPanel.querySelector('.pmb-item');
      if (activeItem) {
        setKeyboardFocus(activeItem);
      }
    }
  } else {
    // 根面板按向右键，回到搜索输入框
    const searchInput = document.getElementById('cascade-search-input');
    if (searchInput) {
      clearKeyboardFocus();
      searchInput.focus();
    }
  }
}

function getFaviconUrl(pageUrl) {
  try {
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', '32');
    return url.toString();
  } catch (e) {
    return '';
  }
}

const ICONS = {
  folder: '<svg class="folder-svg" viewBox="0 0 20 20" fill="currentColor"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3.086a1.5 1.5 0 0 1 1.06.44L9.087 4.88A.5.5 0 0 0 9.44 5H16.5A1.5 1.5 0 0 1 18 6.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 15.5v-11z"/></svg>',
  fileFallback: '<svg class="item-icon" viewBox="0 0 24 24" style="color:var(--text-muted);"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  arrowDown: '<svg viewBox="0 0 16 16" width="11" height="11"><path fill="currentColor" d="M5.5 3.5v9l7-4.5z"/></svg>',
  arrowLeft: '‹'
};

function createFallbackIcon() {
  const span = document.createElement('span');
  span.innerHTML = ICONS.fileFallback;
  return span.firstElementChild;
}


function findNodeInSubTree(id, node) {
  if (!node || !id) return null;
  if (node.id === id) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeInSubTree(id, child);
      if (found) return found;
    }
  }
  return null;
}

function getAncestorPath(id, root) {
  const path = [];
  function search(curr, targetId) {
    if (!curr) return false;
    if (curr.id === targetId) return true;
    if (curr.children) {
      for (const child of curr.children) {
        if (search(child, targetId)) {
          if (curr.id !== '0' && curr.id !== (root && root.id)) {
            path.unshift(curr.id);
          }
          return true;
        }
      }
    }
    return false;
  }
  search(root, id);
  return path;
}

function ensureFolderInCascadePath(targetId) {
  if (!targetId || !bookmarkBarNode) return;
  if (targetId === bookmarkBarNode.id) return;
  const ancestors = getAncestorPath(targetId, bookmarkBarNode);
  openCascadeFolderIds = [...ancestors, targetId];
}

function saveExpandedState() {
  try {
    localStorage.setItem('expanded_folders_', JSON.stringify(Array.from(expandedFolders)));
  } catch (e) {}
}

// ----------------------------------------------------
// 1. Popup my Bookmarks 级联多面板模式 (Cascade Mode)
// ----------------------------------------------------
const panelsContainer = document.getElementById('pmb-panels-container');

function renderCascadeView() {
  panelsContainer.innerHTML = '';
  if (!bookmarkBarNode) {
    panelsContainer.innerHTML = '<div class="empty-state"><p>书签栏暂无书签</p></div>';
    return;
  }

  const targetIds = [...openCascadeFolderIds];
  openCascadeFolderIds = []; // 重建时重新记录

  // 1. 渲染根面板 (depth 0)
  appendCascadePanel(bookmarkBarNode, 0);

  // 2. 依次重建之前已展开的各级子面板
  let currentParent = bookmarkBarNode;
  for (let d = 0; d < targetIds.length; d++) {
    const folderId = targetIds[d];
    const childNode = findNodeInSubTree(folderId, bookmarkTreeData.length ? bookmarkTreeData[0] : currentParent);
    if (childNode) {
      // 标记父面板中对应项为高亮
      const prevPanel = panelsContainer.querySelector(`.pmb-panel[data-depth="${d}"]`);
      if (prevPanel) {
        const itemEl = prevPanel.querySelector(`.pmb-item[data-id="${folderId}"]`);
        if (itemEl) itemEl.classList.add('active');
      }

      appendCascadePanel(childNode, d + 1);
      currentParent = childNode;
    } else {
      break;
    }
  }

  // 3. 如果有新创建的项，进行醒目高亮与自动对焦
  if (lastCreatedBookmarkId) {
    const idToHighlight = lastCreatedBookmarkId;
    setTimeout(() => {
      const newEl = document.querySelector(`.pmb-item[data-id="${idToHighlight}"], .node-row[data-id="${idToHighlight}"]`);
      if (newEl) {
        newEl.classList.add('just-created');
        newEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setTimeout(() => newEl.classList.remove('just-created'), 2500);
      }
    }, 50);
  }
}

function parseSeparatorInfo(title) {
  if (!title) return null;
  const trimmed = title.trim();
  // 1. 纯横线 (如 ---, ──────────, ___)
  if (/^[-─—_\s]{3,}$/.test(trimmed)) {
    return { type: 'pure', text: '' };
  }
  // 2. 带文字的分类分隔条 (如 - - - - - codex - - - - -, --- 常用 ---)
  const match = trimmed.match(/^[-─—_\s]{2,}(.+?)[-─—_\s]{2,}$/);
  if (match && match[1].trim()) {
    return { type: 'labeled', text: match[1].trim() };
  }
  return null;
}

function openEditForNode(node) {
  if (!node) return;
  const isFolder = typeof node.url === 'undefined';
  if (!isFolder) {
    showEditModal({
      title: '修改书签',
      initialTitle: node.title || '',
      initialUrl: node.url || '',
      showUrl: true,
      onSave: async (newTitle, newUrl) => {
        await chrome.bookmarks.update(node.id, {
          title: newTitle,
          url: newUrl || node.url || 'javascript:'
        });
        if (node.parentId) ensureFolderInCascadePath(node.parentId);
        lastCreatedBookmarkId = node.id;
        loadBookmarkTree();
      }
    });
  } else {
    const isRoot = node.id === '1' || (bookmarkBarNode && node.id === bookmarkBarNode.id);
    if (isRoot) return;
    showEditModal({
      title: '修改文件夹',
      initialTitle: node.title || '',
      showUrl: false,
      onSave: async (newTitle) => {
        await chrome.bookmarks.update(node.id, { title: newTitle || node.title });
        ensureFolderInCascadePath(node.parentId || node.id);
        lastCreatedBookmarkId = node.id;
        loadBookmarkTree();
      }
    });
  }
}

function isSeparatorNode(item) {
  if (!item || item.children) return false;
  return Boolean(parseSeparatorInfo(item.title));
}

let draggedBookmarkId = null;

function attachDragAndDropHandlers(itemEl, item, parentFolderNode) {
  // 不允许拖动特殊根节点
  if (item.id === '1' || item.id === '0') return;

  itemEl.draggable = true;

  itemEl.addEventListener('dragstart', (e) => {
    draggedBookmarkId = item.id;
    e.dataTransfer.setData('text/plain', item.id);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => itemEl.classList.add('dragging'), 0);
  });

  itemEl.addEventListener('dragend', () => {
    itemEl.classList.remove('dragging');
    document.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over-folder').forEach(el => {
      el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-folder');
    });
    draggedBookmarkId = null;
  });

  itemEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedBookmarkId || draggedBookmarkId === item.id) return;

    const rect = itemEl.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    const height = rect.height;

    itemEl.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-folder');

    const isFolder = typeof item.url === 'undefined' && !isSeparatorNode(item);
    if (isFolder && offsetY > height * 0.25 && offsetY < height * 0.75) {
      // 拖到文件夹中间 -> 放入该文件夹
      itemEl.classList.add('drag-over-folder');
      e.dataTransfer.dropEffect = 'move';
    } else if (offsetY < height / 2) {
      // 上半部分 -> 插入在该项上方
      itemEl.classList.add('drag-over-top');
      e.dataTransfer.dropEffect = 'move';
    } else {
      // 下半部分 -> 插入在该项下方
      itemEl.classList.add('drag-over-bottom');
      e.dataTransfer.dropEffect = 'move';
    }
  });

  itemEl.addEventListener('dragleave', () => {
    itemEl.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-folder');
  });

  itemEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sourceId = draggedBookmarkId || e.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === item.id) return;

    const isTop = itemEl.classList.contains('drag-over-top');
    const isBottom = itemEl.classList.contains('drag-over-bottom');
    const isIntoFolder = itemEl.classList.contains('drag-over-folder');

    itemEl.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-folder');

    try {
      const sourceNode = await findBookmarkNode(sourceId);
      const targetNode = await findBookmarkNode(item.id);
      if (!sourceNode || !targetNode) return;

      if (isIntoFolder) {
        // 放入文件夹内部
        await chrome.bookmarks.move(sourceId, { parentId: targetNode.id });
        lastCreatedBookmarkId = sourceId;
        ensureFolderInCascadePath(targetNode.id);
        loadBookmarkTree();
        return;
      }

      const targetParentId = targetNode.parentId || (parentFolderNode && parentFolderNode.id);
      if (!targetParentId) return;

      let targetIndex = targetNode.index;
      if (isBottom) {
        targetIndex = targetNode.index + 1;
      }

      await chrome.bookmarks.move(sourceId, { parentId: targetParentId, index: targetIndex });
      lastCreatedBookmarkId = sourceId;
      ensureFolderInCascadePath(targetParentId);
      loadBookmarkTree();
    } catch (err) {
      console.error('拖拽移动书签失败:', err);
    }
  });
}

function populatePanelList(listEl, folderNode, depth) {
  listEl.innerHTML = '';
  let children = [...(folderNode.children || [])];

  // 如果是根面板且开启了置顶其他书签(id='2')且有子项，置于列表顶部
  if (depth === 0 && userSettings.showOtherBookmarks && otherBookmarksNode && otherBookmarksNode.children && otherBookmarksNode.children.length > 0) {
    if (!children.some(c => c.id === otherBookmarksNode.id)) {
      children = [otherBookmarksNode, ...children];
    }
  }

  if (children.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-state';
    emptyEl.innerHTML = '<p>(空文件夹)</p>';
    listEl.appendChild(emptyEl);
  }

  for (const item of children) {
    const sepInfo = parseSeparatorInfo(item.title);
    if (sepInfo && userSettings.prettifySeparators) {
      const sepEl = document.createElement('div');
      sepEl.className = 'pmb-item ' + (sepInfo.type === 'pure' ? 'is-separator' : 'is-section-separator');
      sepEl.dataset.id = item.id;
      sepEl.title = `${item.title || '分割条'} (支持拖拽移动/双击或右键修改/删除)`;

      if (sepInfo.type === 'pure') {
        sepEl.innerHTML = '<div class="separator-line"></div>';
      } else {
        sepEl.innerHTML = `<div class="section-line"></div><span class="section-text">${escapeHtml(sepInfo.text)}</span><div class="section-line"></div>`;
      }
      
      // 分割条作为书签也支持拖拽排序与右键操作
      attachDragAndDropHandlers(sepEl, item, folderNode);

      sepEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      // 双击直接编辑分割条
      sepEl.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openEditForNode(item);
      });

      listEl.appendChild(sepEl);
      continue;
    }

    const isFolder = typeof item.url === 'undefined';
    const itemEl = document.createElement('div');
    itemEl.className = 'pmb-item';
    if (item.id === '2') {
      itemEl.classList.add('other-bookmarks-item');
    }
    itemEl.dataset.id = item.id;
    itemEl.title = item.title || (item.url ? item.url : '未命名');

    // 绑定拖拽移动事件
    attachDragAndDropHandlers(itemEl, item, folderNode);

    // 双击快速编辑
    itemEl.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditForNode(item);
    });

    if (isFolder) {
      // 文件夹项
      const iconWrapper = document.createElement('span');
      iconWrapper.innerHTML = ICONS.folder;
      itemEl.appendChild(iconWrapper.firstElementChild);

      const nameEl = document.createElement('span');
      nameEl.className = 'item-title';
      nameEl.textContent = item.title || '文件夹';
      itemEl.appendChild(nameEl);

      const arrowEl = document.createElement('span');
      arrowEl.className = 'item-arrow';
      arrowEl.textContent = ICONS.arrowLeft;
      itemEl.appendChild(arrowEl);

      // 悬停逻辑 (按配置延时并启用斜向防误触保护)
      itemEl.addEventListener('mouseenter', () => {
        if (isSearching) return;
        clearTimeout(hoverCloseTimer);
        clearTimeout(hoverOpenTimer);

        // 如果当前项本来就是已经激活展开的项，无需重复操作
        if (openCascadeFolderIds[depth] === item.id) return;

        if (userSettings.hoverDelay < 0) return;

        let delay = userSettings.hoverDelay;
        if (isMouseMovingToSubmenu(depth)) {
          delay = Math.max(160, userSettings.hoverDelay + 80);
        }

        hoverOpenTimer = setTimeout(() => {
          listEl.querySelectorAll('.pmb-item').forEach(el => el.classList.remove('active'));
          itemEl.classList.add('active');
          appendCascadePanel(item, depth + 1);
        }, delay);
      });

      itemEl.addEventListener('click', (e) => {
        e.stopPropagation();
        clearTimeout(hoverCloseTimer);
        clearTimeout(hoverOpenTimer);
        listEl.querySelectorAll('.pmb-item').forEach(el => el.classList.remove('active'));
        itemEl.classList.add('active');
        appendCascadePanel(item, depth + 1);
      });

    } else if (item.url) {
      // 书签项
      const imgEl = document.createElement('img');
      imgEl.className = 'item-icon';
      imgEl.src = getFaviconUrl(item.url);
      imgEl.onerror = () => imgEl.replaceWith(createFallbackIcon());
      itemEl.appendChild(imgEl);

      const nameEl = document.createElement('span');
      nameEl.className = 'item-title';
      nameEl.textContent = item.title || item.url;
      itemEl.appendChild(nameEl);

      itemEl.addEventListener('mouseenter', () => {
        if (isSearching) return;
        clearTimeout(hoverOpenTimer);
        clearTimeout(hoverCloseTimer);

        let delay = 140;
        if (isMouseMovingToSubmenu(depth)) {
          delay = 240;
        }

        hoverCloseTimer = setTimeout(() => {
          listEl.querySelectorAll('.pmb-item').forEach(el => el.classList.remove('active'));
          const panels = panelsContainer.querySelectorAll('.pmb-panel');
          panels.forEach(p => {
            if (parseInt(p.dataset.depth, 10) > depth) {
              p.remove();
            }
          });
          openCascadeFolderIds = openCascadeFolderIds.slice(0, depth);
        }, delay);
      });

      // 按照用户设置打开目标
      itemEl.addEventListener('click', (e) => {
        e.preventDefault();
        openBookmarkUrl(item.url, e.ctrlKey || e.metaKey);
      });

      itemEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          openBookmarkUrl(item.url, true);
        }
      });
    }

    listEl.appendChild(itemEl);
  }

  // 容器空白区域允许接收拖拽放入
  listEl.addEventListener('dragover', (e) => {
    if (!draggedBookmarkId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  listEl.addEventListener('drop', async (e) => {
    if (e.target !== listEl && !e.target.classList.contains('empty-state')) return;
    const sourceId = draggedBookmarkId || e.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === folderNode.id) return;
    e.preventDefault();
    try {
      await chrome.bookmarks.move(sourceId, { parentId: folderNode.id });
      lastCreatedBookmarkId = sourceId;
      ensureFolderInCascadePath(folderNode.id);
      loadBookmarkTree();
    } catch (err) {
      console.error('拖入列表末尾失败:', err);
    }
  });
}

function appendCascadePanel(folderNode, depth) {
  // 移除所有大于等于当前深度的面板
  const existing = panelsContainer.querySelectorAll('.pmb-panel');
  existing.forEach(p => {
    if (parseInt(p.dataset.depth, 10) >= depth) {
      p.remove();
    }
  });

  // 更新展开路径
  if (depth > 0) {
    openCascadeFolderIds[depth - 1] = folderNode.id;
    openCascadeFolderIds.length = depth;
  } else {
    openCascadeFolderIds = [];
  }

  const panelEl = document.createElement('div');
  panelEl.className = 'pmb-panel';
  panelEl.dataset.depth = depth;
  panelEl.dataset.folderId = folderNode.id || '';

  // 鼠标进入子面板时立即锁定，取消父级的切换或关闭定时器
  panelEl.addEventListener('mouseenter', () => {
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
  });

  // 1. 面板头部
  const headerEl = document.createElement('div');
  headerEl.className = 'pmb-header ' + (depth === 0 ? 'root-header' : 'sub-header');

  const titleEl = document.createElement('span');
  titleEl.className = 'header-title';
  titleEl.textContent = depth === 0 ? '书签栏' : (folderNode.title || '文件夹');
  titleEl.title = titleEl.textContent;
  headerEl.appendChild(titleEl);

  if (depth === 0) {
    const toolsEl = document.createElement('div');
    toolsEl.className = 'header-tools';

    const switchBtn = document.createElement('button');
    switchBtn.className = 'h-btn';
    switchBtn.title = '切换到树状折叠模式';
    switchBtn.textContent = '🌲 树状';
    switchBtn.addEventListener('click', () => applyViewMode('tree'));
    toolsEl.appendChild(switchBtn);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'h-btn';
    settingsBtn.title = '插件设置 (宽高/快捷键/交互)';
    settingsBtn.textContent = '⚙ 设置';
    settingsBtn.addEventListener('click', () => openSettingsModal());
    toolsEl.appendChild(settingsBtn);

    const mgrBtn = document.createElement('button');
    mgrBtn.className = 'h-btn';
    mgrBtn.title = '打开原生书签管理器';
    mgrBtn.textContent = '📑';
    mgrBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://bookmarks' });
      window.close();
    });
    toolsEl.appendChild(mgrBtn);

    headerEl.appendChild(toolsEl);
  } else {
    // 子面板添加关闭按钮
    const closeBtn = document.createElement('button');
    closeBtn.className = 'h-btn h-btn-close';
    closeBtn.title = '关闭此面板';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panelEl.remove();
      openCascadeFolderIds = openCascadeFolderIds.slice(0, depth - 1);
      const parentPanel = panelsContainer.querySelector(`.pmb-panel[data-depth="${depth - 1}"]`);
      if (parentPanel) {
        parentPanel.querySelectorAll('.pmb-item.active').forEach(el => el.classList.remove('active'));
      }
    });
    headerEl.appendChild(closeBtn);
  }

  panelEl.appendChild(headerEl);

  // 2. 根面板提供搜索框 (永久常驻于根面板，绝不因为输入丢失焦点)
  if (depth === 0) {
    const searchWrap = document.createElement('div');
    searchWrap.className = 'search-box-wrap';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'cascade-search-input';
    searchInput.className = 'search-input';
    searchInput.placeholder = '搜索';
    searchInput.autocomplete = 'off';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'clear-btn hidden';
    clearBtn.textContent = '✕';

    let timer = null;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(timer);
      const val = e.target.value;
      clearBtn.classList.toggle('hidden', !val);
      timer = setTimeout(() => handleCascadeSearch(val), 100);
    });

    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.classList.add('hidden');
      handleCascadeSearch('');
      searchInput.focus();
    });

    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(clearBtn);
    panelEl.appendChild(searchWrap);
  }

  // 3. 列表区域
  const listEl = document.createElement('div');
  listEl.className = 'pmb-list';
  if (depth === 0) listEl.id = 'root-panel-list';

  populatePanelList(listEl, folderNode, depth);

  panelEl.addEventListener('mouseenter', () => {
    clearTimeout(hoverCloseTimer);
  });

  panelEl.appendChild(listEl);
  panelsContainer.appendChild(panelEl);
}

// 根面板即时搜索逻辑 (搜索结果在当前根列表中渲染，搜索框全程保持对焦)
async function handleCascadeSearch(query) {
  const rootList = document.getElementById('root-panel-list');
  if (!rootList) return;

  const trimmed = (query || '').trim();
  if (!trimmed) {
    isSearching = false;
    clearKeyboardFocus();
    // 恢复根面板书签树
    populatePanelList(rootList, bookmarkBarNode, 0);
    return;
  }

  isSearching = true;
  clearKeyboardFocus();
  // 关闭所有已打开的子面板
  const panels = panelsContainer.querySelectorAll('.pmb-panel');
  panels.forEach(p => {
    if (parseInt(p.dataset.depth, 10) > 0) {
      p.remove();
    }
  });

  try {
    const results = await chrome.bookmarks.search(trimmed);
    rootList.innerHTML = '';

    const bookmarkOnly = (results || []).filter(item => Boolean(item && item.url));
    if (bookmarkOnly.length === 0) {
      rootList.innerHTML = '<div class="empty-state"><p>未找到匹配书签</p></div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of bookmarkOnly) {
      const itemEl = document.createElement('div');
      itemEl.className = 'search-item';
      itemEl.title = item.url;

      const imgEl = document.createElement('img');
      imgEl.className = 'item-icon';
      imgEl.src = getFaviconUrl(item.url);
      imgEl.onerror = () => imgEl.replaceWith(createFallbackIcon());
      itemEl.appendChild(imgEl);

      const infoEl = document.createElement('div');
      infoEl.className = 'search-item-info';

      const titleEl = document.createElement('div');
      titleEl.className = 'search-item-title';
      titleEl.innerHTML = highlightMatch(item.title || item.url, trimmed);
      infoEl.appendChild(titleEl);

      const urlEl = document.createElement('div');
      urlEl.className = 'search-item-url';
      urlEl.textContent = item.url;
      infoEl.appendChild(urlEl);

      itemEl.appendChild(infoEl);

      itemEl.addEventListener('click', (e) => {
        e.preventDefault();
        openBookmarkUrl(item.url, e.ctrlKey || e.metaKey);
      });

      itemEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          openBookmarkUrl(item.url, true);
        }
      });

      fragment.appendChild(itemEl);
    }
    rootList.appendChild(fragment);
  } catch (e) {
    console.error('搜索出错:', e);
  }
}

// ----------------------------------------------------
// 2. 经典树状视图模式 (Tree Mode)
// ----------------------------------------------------
const treeContainer = document.getElementById('pmb-tree-container');
const treeList = document.getElementById('tree-list');

function createTreeNode(node, depth = 0) {
  if (!node) return null;

  const isFolder = !node.url && Array.isArray(node.children);
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';
  nodeEl.dataset.id = node.id || '';

  if (isSeparatorNode(node)) {
    const sepRow = document.createElement('div');
    sepRow.className = 'node-row is-separator';
    sepRow.dataset.id = node.id;
    sepRow.title = '分割条 (支持拖拽移动/右键修改/删除)';
    sepRow.innerHTML = '<div class="separator-line" style="width:100%;height:1px;background:var(--border-color);margin:4px 0;"></div>';
    attachDragAndDropHandlers(sepRow, node, null);
    nodeEl.appendChild(sepRow);
    return nodeEl;
  }

  const rowEl = document.createElement('div');
  rowEl.className = 'node-row';
  rowEl.dataset.id = node.id;
  rowEl.title = node.title || (node.url ? node.url : '未命名');

  // 绑定拖拽移动
  attachDragAndDropHandlers(rowEl, node, null);

  if (isFolder) {
    const isExpanded = expandedFolders.has(node.id);
    if (isExpanded && node.id) {
      expandedFolders.add(node.id);
    }

    const hasChildren = node.children && node.children.length > 0;

    const arrowEl = document.createElement('span');
    arrowEl.className = 'toggle-arrow ' + (isExpanded ? 'expanded' : '') + ' ' + (!hasChildren ? 'empty' : '');
    arrowEl.innerHTML = ICONS.arrowDown;
    rowEl.appendChild(arrowEl);

    const iconWrapper = document.createElement('span');
    iconWrapper.innerHTML = ICONS.folder;
    rowEl.appendChild(iconWrapper.firstElementChild);

    const titleEl = document.createElement('span');
    titleEl.className = 'node-title';
    titleEl.textContent = node.title || '文件夹';
    rowEl.appendChild(titleEl);

    nodeEl.appendChild(rowEl);

    const childrenEl = document.createElement('div');
    childrenEl.className = 'children-container ' + (isExpanded ? 'open' : '');

    if (hasChildren) {
      const fragment = document.createDocumentFragment();
      for (const child of node.children) {
        const childNode = createTreeNode(child, depth + 1);
        if (childNode) fragment.appendChild(childNode);
      }
      childrenEl.appendChild(fragment);
    }

    nodeEl.appendChild(childrenEl);

    rowEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = childrenEl.classList.toggle('open');
      arrowEl.classList.toggle('expanded', open);

      if (node.id) {
        if (open) {
          expandedFolders.add(node.id);
        } else {
          expandedFolders.delete(node.id);
        }
        saveExpandedState();
      }
    });

    

  } else if (node.url) {
    const indentPlaceholder = document.createElement('span');
    indentPlaceholder.className = 'toggle-arrow empty';
    rowEl.appendChild(indentPlaceholder);

    const imgEl = document.createElement('img');
    imgEl.className = 'item-icon';
    imgEl.src = getFaviconUrl(node.url);
    imgEl.onerror = () => imgEl.replaceWith(createFallbackIcon());
    rowEl.appendChild(imgEl);

    const titleEl = document.createElement('span');
    titleEl.className = 'node-title';
    titleEl.textContent = node.title || node.url;
    rowEl.appendChild(titleEl);

    nodeEl.appendChild(rowEl);

    rowEl.addEventListener('click', (e) => {
      e.preventDefault();
      openBookmarkUrl(node.url, e.ctrlKey || e.metaKey);
    });

    rowEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        openBookmarkUrl(node.url, true);
      }
    });

  }

  return nodeEl;
}

function renderTreeView() {
  treeList.innerHTML = '';
  if (!bookmarkBarNode || !bookmarkBarNode.children || bookmarkBarNode.children.length === 0) {
    treeList.innerHTML = '<div class="empty-state"><p>书签栏暂无书签</p></div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of bookmarkBarNode.children) {
    const el = createTreeNode(item, 0);
    if (el) fragment.appendChild(el);
  }
  treeList.appendChild(fragment);
}

// 树状模式即时搜索
async function handleTreeSearch(query) {
  const trimmed = (query || '').trim();
  if (!trimmed) {
    clearKeyboardFocus();
    renderTreeView();
    return;
  }

  clearKeyboardFocus();
  try {
    const results = await chrome.bookmarks.search(trimmed);
    treeList.innerHTML = '';

    const bookmarkOnly = (results || []).filter(item => Boolean(item && item.url));
    if (bookmarkOnly.length === 0) {
      treeList.innerHTML = '<div class="empty-state"><p>未找到匹配书签</p></div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of bookmarkOnly) {
      const itemEl = document.createElement('div');
      itemEl.className = 'search-item';
      itemEl.title = item.url;

      const imgEl = document.createElement('img');
      imgEl.className = 'item-icon';
      imgEl.src = getFaviconUrl(item.url);
      imgEl.onerror = () => imgEl.replaceWith(createFallbackIcon());
      itemEl.appendChild(imgEl);

      const infoEl = document.createElement('div');
      infoEl.className = 'search-item-info';

      const titleEl = document.createElement('div');
      titleEl.className = 'search-item-title';
      titleEl.innerHTML = highlightMatch(item.title || item.url, trimmed);
      infoEl.appendChild(titleEl);

      const urlEl = document.createElement('div');
      urlEl.className = 'search-item-url';
      urlEl.textContent = item.url;
      infoEl.appendChild(urlEl);

      itemEl.appendChild(infoEl);

      itemEl.addEventListener('click', (e) => {
        e.preventDefault();
        openBookmarkUrl(item.url, e.ctrlKey || e.metaKey);
      });

      itemEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          openBookmarkUrl(item.url, true);
        }
      });

      fragment.appendChild(itemEl);
    }
    treeList.appendChild(fragment);
  } catch (e) {
    console.error('搜索出错:', e);
  }
}

// ----------------------------------------------------
// 3. 模式切换
// ----------------------------------------------------
function applyViewMode(mode) {
  clearKeyboardFocus();
  currentViewMode = mode;
  try {
    localStorage.setItem('bookmark_view_mode_', mode);
  } catch (e) {}

  if (mode === 'cascade') {
    panelsContainer.classList.remove('hidden');
    treeContainer.classList.add('hidden');
    renderCascadeView();
  } else {
    panelsContainer.classList.add('hidden');
    treeContainer.classList.remove('hidden');
    renderTreeView();
  }
}

document.getElementById('btn-switch-to-cascade').addEventListener('click', () => {
  applyViewMode('cascade');
});

document.getElementById('btn-tree-expand').addEventListener('click', () => {
  treeList.querySelectorAll('.children-container').forEach(el => el.classList.add('open'));
  treeList.querySelectorAll('.toggle-arrow:not(.empty)').forEach(el => el.classList.add('expanded'));
  treeList.querySelectorAll('.tree-node').forEach(el => {
    if (el.dataset.id) expandedFolders.add(el.dataset.id);
  });
  saveExpandedState();
});

document.getElementById('btn-tree-collapse').addEventListener('click', () => {
  treeList.querySelectorAll('.children-container').forEach(el => el.classList.remove('open'));
  treeList.querySelectorAll('.toggle-arrow:not(.empty)').forEach(el => el.classList.remove('expanded'));
  expandedFolders.clear();
  saveExpandedState();
});

document.getElementById('btn-tree-manager').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://bookmarks' });
  window.close();
});

const treeSearchInput = document.getElementById('tree-search-input');
const clearTreeSearch = document.getElementById('clear-tree-search');
let treeSearchTimer = null;

treeSearchInput.addEventListener('input', (e) => {
  clearTimeout(treeSearchTimer);
  const val = e.target.value;
  clearTreeSearch.classList.toggle('hidden', !val);
  treeSearchTimer = setTimeout(() => handleTreeSearch(val), 100);
});

clearTreeSearch.addEventListener('click', () => {
  treeSearchInput.value = '';
  clearTreeSearch.classList.add('hidden');
  handleTreeSearch('');
  treeSearchInput.focus();
});

function escapeHtml(str) {
  return (str || '').replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

function highlightMatch(text, query) {
  if (!text) return '';
  if (!query) return escapeHtml(text);
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('(' + escaped + ')', 'gi');
    return escapeHtml(text).replace(regex, '<span class="highlight">$1</span>');
  } catch (e) {
    return escapeHtml(text);
  }
}

function extractUrls(node, urls = []) {
  if (!node) return urls;
  if (node.url) {
    urls.push(node.url);
  } else if (node.children) {
    for (const child of node.children) {
      extractUrls(child, urls);
    }
  }
  return urls;
}

// ----------------------------------------------------
// 4. 剪贴板与右键菜单动作
// ----------------------------------------------------
let bookmarkClipboard = null; // { action: 'cut'|'copy', id: string, node: object }

async function duplicateBookmarkNode(sourceNode, targetParentId, targetIndex) {
  if (sourceNode.url) {
    const created = await chrome.bookmarks.create({
      parentId: targetParentId,
      index: targetIndex,
      title: sourceNode.title,
      url: sourceNode.url
    });
    lastCreatedBookmarkId = created.id;
    return created;
  } else {
    const createdFolder = await chrome.bookmarks.create({
      parentId: targetParentId,
      index: targetIndex,
      title: sourceNode.title || '新建文件夹'
    });
    lastCreatedBookmarkId = createdFolder.id;
    if (sourceNode.children && sourceNode.children.length > 0) {
      for (const child of sourceNode.children) {
        await duplicateBookmarkNode(child, createdFolder.id);
      }
    }
    return createdFolder;
  }
}

async function sortBookmarksByName(folderId) {
  try {
    const children = await chrome.bookmarks.getChildren(folderId);
    if (!children || children.length <= 1) return;

    const sorted = [...children].sort((a, b) => {
      return (a.title || '').localeCompare(b.title || '', 'zh-CN', { numeric: true, sensitivity: 'base' });
    });

    for (let i = 0; i < sorted.length; i++) {
      await chrome.bookmarks.move(sorted[i].id, { parentId: folderId, index: i });
    }
    ensureFolderInCascadePath(folderId);
    loadBookmarkTree();
  } catch (err) {
    console.error('排序失败:', err);
  }
}

const bookmarkMenu = document.getElementById('bookmark-context-menu');
const folderMenu = document.getElementById('folder-context-menu');

async function findBookmarkNode(id) {
  if (!id) return null;
  try {
    const res = await chrome.bookmarks.get(id);
    return res && res.length > 0 ? res[0] : null;
  } catch (e) {
    return null;
  }
}

function showContextMenu(x, y, node, type) {
  hideContextMenu();
  activeContextMenuTarget = node;
  activeContextMenuType = type;

  const menu = type === 'folder' ? folderMenu : bookmarkMenu;
  if (!menu) return;

  const isRoot = node.id === '1' || (bookmarkBarNode && node.id === bookmarkBarNode.id);
  const editItem = menu.querySelector('[data-action="edit"]');
  const deleteItem = menu.querySelector('[data-action="delete"]');
  if (editItem) editItem.style.display = (type === 'folder' && isRoot) ? 'none' : 'flex';
  if (deleteItem) deleteItem.style.display = (type === 'folder' && isRoot) ? 'none' : 'flex';

  const pasteBtn = menu.querySelector('[data-action="paste"]');
  if (pasteBtn) {
    pasteBtn.classList.toggle('disabled', !bookmarkClipboard);
  }

  menu.classList.remove('hidden');

  const menuWidth = menu.offsetWidth || 140;
  const menuHeight = menu.offsetHeight || 300;

  const winWidth = window.innerWidth || document.documentElement.clientWidth || 500;
  const winHeight = window.innerHeight || document.documentElement.clientHeight || 520;

  let posX = x;
  let posY = y;

  if (posX + menuWidth > winWidth - 4) {
    posX = Math.max(4, winWidth - menuWidth - 4);
  }
  if (posY + menuHeight > winHeight - 4) {
    posY = Math.max(4, winHeight - menuHeight - 4);
  }

  menu.style.left = posX + 'px';
  menu.style.top = posY + 'px';
}

function hideContextMenu() {
  if (bookmarkMenu) bookmarkMenu.classList.add('hidden');
  if (folderMenu) folderMenu.classList.add('hidden');
}

// 全局右键事件委托 (支持书签项、文件夹项以及面板空白处)
document.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  
  // 1. 如果右键点击了具体的书签或文件夹项
  const itemEl = e.target.closest('.pmb-item, .node-row, .search-item');
  if (itemEl) {
    const id = itemEl.dataset.id;
    if (id) {
      const node = await findBookmarkNode(id);
      if (node) {
        const isFolder = typeof node.url === 'undefined';
        showContextMenu(e.clientX, e.clientY, node, isFolder ? 'folder' : 'bookmark');
        return;
      }
    }
  }

  // 2. 如果右键点击了多级面板的空白处，显示该面板对应文件夹的菜单
  const panelEl = e.target.closest('.pmb-panel');
  if (panelEl) {
    const folderId = panelEl.dataset.folderId || (bookmarkBarNode && bookmarkBarNode.id);
    if (folderId) {
      const node = await findBookmarkNode(folderId);
      if (node) {
        showContextMenu(e.clientX, e.clientY, node, 'folder');
        return;
      }
    }
  }

  // 3. 如果右键点击了树状折叠视图的空白处，显示根文件夹菜单
  const treeEl = e.target.closest('.pmb-tree-container');
  if (treeEl && bookmarkBarNode) {
    const node = await findBookmarkNode(bookmarkBarNode.id);
    if (node) {
      showContextMenu(e.clientX, e.clientY, node, 'folder');
      return;
    }
  }

  hideContextMenu();
});

// 左键点击任意非菜单区域关闭右键菜单
document.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    if (bookmarkMenu && folderMenu && !bookmarkMenu.contains(e.target) && !folderMenu.contains(e.target)) {
      hideContextMenu();
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideContextMenu();
  }
});

// ----------------------------------------------------
// 右键菜单统一动作响应
// ----------------------------------------------------
async function handleContextMenuClick(e, isFolderMenu) {
  const item = e.target.closest('.menu-item');
  if (!item || item.classList.contains('disabled') || !activeContextMenuTarget) return;

  const action = item.dataset.action;
  const target = activeContextMenuTarget;
  hideContextMenu();

  let allUrls = [];
  if (isFolderMenu || typeof target.url === 'undefined') {
    try {
      const fullSubTree = (await chrome.bookmarks.getSubTree(target.id))[0];
      allUrls = extractUrls(fullSubTree);
    } catch (err) {}
  }

  switch (action) {
    case 'open-bg-tab':
      if (target.url) {
        chrome.tabs.create({ url: target.url, active: false });
      }
      break;

    case 'open-all-bg':
      for (const u of allUrls) {
        chrome.tabs.create({ url: u, active: false });
      }
      break;

    case 'open-new-window':
      if (target.url) {
        chrome.windows.create({ url: target.url });
        window.close();
      }
      break;

    case 'open-all-window':
      if (allUrls.length > 0) {
        chrome.windows.create({ url: allUrls });
        window.close();
      }
      break;

    case 'open-incognito':
      if (target.url) {
        chrome.windows.create({ url: target.url, incognito: true });
        window.close();
      }
      break;

    case 'open-all-incognito':
      if (allUrls.length > 0) {
        chrome.windows.create({ url: allUrls, incognito: true });
        window.close();
      }
      break;

    case 'edit':
      openEditForNode(target);
      break;

    case 'delete':
      if (target.url) {
        await chrome.bookmarks.remove(target.id);
        if (target.parentId) ensureFolderInCascadePath(target.parentId);
        loadBookmarkTree();
      } else {
        await chrome.bookmarks.removeTree(target.id);
        if (target.parentId) ensureFolderInCascadePath(target.parentId);
        loadBookmarkTree();
      }
      break;

    case 'cut':
      bookmarkClipboard = { action: 'cut', id: target.id, isFolder: !target.url };
      break;

    case 'copy':
      try {
        const fullNode = (await chrome.bookmarks.getSubTree(target.id))[0];
        bookmarkClipboard = { action: 'copy', node: fullNode, isFolder: !target.url };
      } catch (err) {
        bookmarkClipboard = { action: 'copy', node: target, isFolder: !target.url };
      }
      break;

    case 'paste':
      if (!bookmarkClipboard) return;
      {
        const isTargetFolder = !target.url;
        const destParentId = isTargetFolder ? target.id : (target.parentId || (bookmarkBarNode && bookmarkBarNode.id));
        const destIndex = isTargetFolder ? undefined : (typeof target.index === 'number' ? target.index + 1 : undefined);

        if (bookmarkClipboard.action === 'cut') {
          await chrome.bookmarks.move(bookmarkClipboard.id, { parentId: destParentId, index: destIndex });
          lastCreatedBookmarkId = bookmarkClipboard.id;
          bookmarkClipboard = null;
        } else if (bookmarkClipboard.action === 'copy' && bookmarkClipboard.node) {
          await duplicateBookmarkNode(bookmarkClipboard.node, destParentId, destIndex);
        }
        ensureFolderInCascadePath(destParentId);
        loadBookmarkTree();
      }
      break;

    case 'add-current-page':
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
          const isTargetFolder = !target.url;
          const parentId = isTargetFolder ? target.id : (target.parentId || (bookmarkBarNode && bookmarkBarNode.id));
          const index = isTargetFolder ? undefined : (typeof target.index === 'number' ? target.index + 1 : undefined);
          const created = await chrome.bookmarks.create({
            parentId,
            index,
            title: activeTab.title || activeTab.url || '新书签',
            url: activeTab.url
          });
          lastCreatedBookmarkId = created.id;
          ensureFolderInCascadePath(parentId);
          loadBookmarkTree();
        }
      } catch (err) {
        console.error('添加当前网页失败:', err);
      }
      break;

    case 'add-folder':
      {
        const isTargetFolder = !target.url;
        const parentId = isTargetFolder ? target.id : (target.parentId || (bookmarkBarNode && bookmarkBarNode.id));
        showEditModal({
          title: '添加文件夹',
          initialTitle: '',
          showUrl: false,
          onSave: async (newTitle) => {
            const created = await chrome.bookmarks.create({
              parentId,
              title: newTitle || '新建文件夹'
            });
            if (created) {
              lastCreatedBookmarkId = created.id;
              ensureFolderInCascadePath(parentId);
            }
            loadBookmarkTree();
          }
        });
      }
      break;

    case 'add-separator':
      {
        const isTargetFolder = !target.url;
        const parentId = isTargetFolder ? target.id : (target.parentId || (bookmarkBarNode && bookmarkBarNode.id));
        const index = isTargetFolder ? undefined : (typeof target.index === 'number' ? target.index + 1 : undefined);
        const sep = await chrome.bookmarks.create({
          parentId,
          index,
          title: '──────────',
          url: 'javascript:'
        });
        lastCreatedBookmarkId = sep.id;
        ensureFolderInCascadePath(parentId);
        loadBookmarkTree();
      }
      break;

    case 'sort-by-name':
      {
        const folderId = !target.url ? target.id : (target.parentId || (bookmarkBarNode && bookmarkBarNode.id));
        if (folderId) {
          await sortBookmarksByName(folderId);
        }
      }
      break;
  }
}

bookmarkMenu.addEventListener('click', (e) => handleContextMenuClick(e, false));
folderMenu.addEventListener('click', (e) => handleContextMenuClick(e, true));

// ----------------------------------------------------
// 5. 编辑对话框
// ----------------------------------------------------
const editModal = document.getElementById('edit-modal');
const modalTitle = document.getElementById('modal-title');
const modalInputTitle = document.getElementById('modal-input-title');
const modalInputUrl = document.getElementById('modal-input-url');
const modalUrlGroup = document.getElementById('modal-url-group');

function showEditModal({ title, initialTitle, initialUrl, showUrl, onSave }) {
  modalTitle.textContent = title;
  modalInputTitle.value = initialTitle || '';
  modalInputUrl.value = initialUrl || '';
  modalUrlGroup.style.display = showUrl ? 'block' : 'none';
  modalCallback = onSave;

  editModal.classList.remove('hidden');
  modalInputTitle.focus();
  modalInputTitle.select();
}

function closeEditModal() {
  editModal.classList.add('hidden');
  modalCallback = null;
}

document.getElementById('btn-modal-cancel').addEventListener('click', () => closeEditModal());

document.getElementById('btn-modal-save').addEventListener('click', async () => {
  if (modalCallback) {
    const title = modalInputTitle.value.trim();
    const url = modalInputUrl.value.trim();
    await modalCallback(title, url);
  }
  closeEditModal();
});

editModal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btn-modal-save').click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeEditModal();
  }
});

// ----------------------------------------------------
// 5. 设置对话框与快捷键配置
// ----------------------------------------------------
const settingsModal = document.getElementById('settings-modal');
const settingPanelWidth = document.getElementById('setting-panel-width');
const settingPopupHeight = document.getElementById('setting-popup-height');
const settingItemHeight = document.getElementById('setting-item-height');
const settingFontSize = document.getElementById('setting-font-size');
const settingOpenTarget = document.getElementById('setting-open-target');
const settingHoverDelay = document.getElementById('setting-hover-delay');
const settingShowOtherBookmarks = document.getElementById('setting-show-other-bookmarks');
const settingPrettifySeparators = document.getElementById('setting-prettify-separators');

function openSettingsModal() {
  settingPanelWidth.value = userSettings.panelWidth || 230;
  settingPopupHeight.value = userSettings.popupHeight || 520;
  settingItemHeight.value = String(userSettings.itemHeight || 22);
  settingFontSize.value = String(userSettings.fontSize || 12);
  settingOpenTarget.value = userSettings.openTarget || 'current';
  settingHoverDelay.value = String(typeof userSettings.hoverDelay === 'number' ? userSettings.hoverDelay : 50);
  settingShowOtherBookmarks.checked = Boolean(userSettings.showOtherBookmarks);
  settingPrettifySeparators.checked = Boolean(userSettings.prettifySeparators);

  settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
}

document.getElementById('btn-settings-close').addEventListener('click', () => closeSettingsModal());

document.getElementById('btn-settings-save').addEventListener('click', async () => {
  let pw = parseInt(settingPanelWidth.value, 10);
  let ph = parseInt(settingPopupHeight.value, 10);
  if (isNaN(pw) || pw < 160) pw = 160;
  if (pw > 500) pw = 500;
  if (isNaN(ph) || ph < 300) ph = 300;
  if (ph > 600) ph = 600;

  const newSettings = {
    panelWidth: pw,
    popupHeight: ph,
    itemHeight: parseInt(settingItemHeight.value, 10) || 22,
    fontSize: parseInt(settingFontSize.value, 10) || 12,
    openTarget: settingOpenTarget.value || 'current',
    hoverDelay: parseInt(settingHoverDelay.value, 10),
    showOtherBookmarks: settingShowOtherBookmarks.checked,
    prettifySeparators: settingPrettifySeparators.checked
  };

  await saveUserSettings(newSettings);
  closeSettingsModal();
});

document.getElementById('btn-settings-reset').addEventListener('click', async () => {
  if (confirm('确定要恢复所有设置到默认值吗？')) {
    await saveUserSettings(DEFAULT_SETTINGS);
    openSettingsModal();
  }
});

document.getElementById('btn-open-shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

settingsModal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btn-settings-save').click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSettingsModal();
  }
});

// ----------------------------------------------------
// 全局键盘快捷键与无缝导航
// ----------------------------------------------------
document.addEventListener('keydown', (e) => {
  // 1. Ctrl+F / Cmd+F 聚焦搜索框
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    const input = document.getElementById('cascade-search-input') || treeSearchInput;
    if (input) {
      input.focus();
      input.select();
    }
    return;
  }

  // 2. 如果模态对话框处于显示状态，交由模态框本身处理，不触发列表导航
  const editModal = document.getElementById('edit-modal');
  const settingsModal = document.getElementById('settings-modal');
  if ((editModal && !editModal.classList.contains('hidden')) || 
      (settingsModal && !settingsModal.classList.contains('hidden'))) {
    return;
  }

  // 3. 如果右键菜单处于显示状态，优先处理右键菜单
  const bookmarkMenu = document.getElementById('bookmark-context-menu');
  const folderMenu = document.getElementById('folder-context-menu');
  const isContextMenuOpen = (bookmarkMenu && !bookmarkMenu.classList.contains('hidden')) ||
                            (folderMenu && !folderMenu.classList.contains('hidden'));
  if (isContextMenuOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideContextMenu();
    }
    return;
  }

  const cascadeInput = document.getElementById('cascade-search-input');
  const treeInput = document.getElementById('tree-search-input');
  const isInputFocused = (document.activeElement === cascadeInput || document.activeElement === treeInput);
  const activeInput = isInputFocused ? document.activeElement : null;

  // 4. 当焦点在搜索框内时的键盘导航
  if (isInputFocused && activeInput) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const items = getActiveNavigationItems();
      if (items.length > 0) {
        activeInput.blur();
        setKeyboardFocus(items[0]);
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (keyboardFocusedEl) {
        triggerItemAction(keyboardFocusedEl, e.ctrlKey || e.metaKey);
      } else {
        const items = getActiveNavigationItems();
        if (items.length > 0) {
          triggerItemAction(items[0], e.ctrlKey || e.metaKey);
        }
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (activeInput.value) {
        activeInput.value = '';
        if (activeInput === cascadeInput) {
          const clearBtn = activeInput.nextElementSibling;
          if (clearBtn) clearBtn.classList.add('hidden');
          handleCascadeSearch('');
        } else {
          const clearBtn = document.getElementById('clear-tree-search');
          if (clearBtn) clearBtn.classList.add('hidden');
          handleTreeSearch('');
        }
      } else {
        window.close();
      }
      return;
    }

    return;
  }

  // 5. 焦点在列表项或窗口中的键盘导航
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const items = getActiveNavigationItems();
    if (items.length === 0) return;
    if (!keyboardFocusedEl || !items.includes(keyboardFocusedEl)) {
      setKeyboardFocus(items[0]);
    } else {
      const idx = items.indexOf(keyboardFocusedEl);
      const nextIdx = (idx + 1) % items.length;
      setKeyboardFocus(items[nextIdx]);
    }
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    const items = getActiveNavigationItems();
    if (items.length === 0) return;
    if (!keyboardFocusedEl || !items.includes(keyboardFocusedEl)) {
      setKeyboardFocus(items[items.length - 1]);
    } else {
      const idx = items.indexOf(keyboardFocusedEl);
      if (idx === 0) {
        const currentPanel = keyboardFocusedEl.closest('.pmb-panel');
        const depth = parseInt(currentPanel?.dataset?.depth || '0', 10);
        if (depth === 0 || currentViewMode === 'tree' || isSearching) {
          clearKeyboardFocus();
          const targetInput = (currentViewMode === 'cascade') ? cascadeInput : treeInput;
          if (targetInput) {
            targetInput.focus();
            targetInput.select();
          }
          return;
        }
        setKeyboardFocus(items[items.length - 1]);
      } else {
        setKeyboardFocus(items[idx - 1]);
      }
    }
    return;
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    handleNavigateRight();
    return;
  }

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    handleNavigateLeft();
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    if (keyboardFocusedEl) {
      triggerItemAction(keyboardFocusedEl, e.ctrlKey || e.metaKey);
    } else {
      const items = getActiveNavigationItems();
      if (items.length > 0) {
        triggerItemAction(items[0], e.ctrlKey || e.metaKey);
      }
    }
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    if (currentViewMode === 'cascade' && !isSearching) {
      const currentPanel = keyboardFocusedEl ? keyboardFocusedEl.closest('.pmb-panel') : null;
      const depth = parseInt(currentPanel?.dataset?.depth || '0', 10);
      if (depth > 0) {
        handleNavigateRight();
        return;
      }
    }
    window.close();
    return;
  }
});

// ----------------------------------------------------
// 6. 数据加载
// ----------------------------------------------------
async function loadBookmarkTree() {
  try {
    const tree = await chrome.bookmarks.getTree();
    bookmarkTreeData = tree || [];

    const rootNodes = (tree && tree.length > 0 && tree[0].children) ? tree[0].children : tree;

    bookmarkBarNode = Array.isArray(rootNodes)
      ? (rootNodes.find(n => n.id === '1') || rootNodes[0])
      : null;

    otherBookmarksNode = Array.isArray(rootNodes)
      ? rootNodes.find(n => n.id === '2')
      : null;

    applyViewMode(currentViewMode);
  } catch (error) {
    console.error('加载书签失败:', error);
    panelsContainer.innerHTML = '<div class="empty-state"><p style="color:#d93025;">加载书签出错: ' + error.message + '</p></div>';
  }
}

if (chrome.bookmarks && chrome.bookmarks.onCreated) {
  chrome.bookmarks.onCreated.addListener(() => loadBookmarkTree());
  chrome.bookmarks.onRemoved.addListener(() => loadBookmarkTree());
  chrome.bookmarks.onChanged.addListener(() => loadBookmarkTree());
  chrome.bookmarks.onMoved.addListener(() => loadBookmarkTree());
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadUserSettings();
  loadBookmarkTree();
});
