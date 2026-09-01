// 极简侧边栏书签 sidepanel.js

let bookmarkTreeData = [];
let expandedFolders = new Set(JSON.parse(localStorage.getItem('expanded_folders_') || '[]'));
let activeContextMenuTarget = null;

// Favicon URL 解析器 (使用 Chrome 官方 Favicon API)
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

// 默认图标 SVG
const ICONS = {
  folder: '<svg class="item-icon folder-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
  fileFallback: '<svg class="item-icon" viewBox="0 0 24 24" style="color:var(--text-muted);"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>'
};

// 安全保存折叠状态
function saveExpandedState() {
  try {
    localStorage.setItem('expanded_folders_', JSON.stringify(Array.from(expandedFolders)));
  } catch (e) {
    console.warn('无法保存状态到 localStorage', e);
  }
}

function parseSeparatorInfo(title) {
  if (!title) return null;
  const trimmed = title.trim();
  if (/^[-─—_\s]{3,}$/.test(trimmed)) {
    return { type: 'pure', text: '' };
  }
  const match = trimmed.match(/^[-─—_\s]{2,}(.+?)[-─—_\s]{2,}$/);
  if (match && match[1].trim()) {
    return { type: 'labeled', text: match[1].trim() };
  }
  return null;
}

function isSeparatorNode(item) {
  if (!item || item.children) return false;
  return Boolean(parseSeparatorInfo(item.title));
}

let draggedBookmarkId = null;

function attachDragAndDropHandlers(itemEl, item) {
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
      itemEl.classList.add('drag-over-folder');
      e.dataTransfer.dropEffect = 'move';
    } else if (offsetY < height / 2) {
      itemEl.classList.add('drag-over-top');
      e.dataTransfer.dropEffect = 'move';
    } else {
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

    const isBottom = itemEl.classList.contains('drag-over-bottom');
    const isIntoFolder = itemEl.classList.contains('drag-over-folder');

    itemEl.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-folder');

    try {
      const sourceNode = (await chrome.bookmarks.get(sourceId))[0];
      const targetNode = (await chrome.bookmarks.get(item.id))[0];
      if (!sourceNode || !targetNode) return;

      if (isIntoFolder) {
        await chrome.bookmarks.move(sourceId, { parentId: targetNode.id });
        loadBookmarkTree();
        return;
      }

      const targetParentId = targetNode.parentId;
      let targetIndex = targetNode.index;
      if (isBottom) {
        targetIndex = targetNode.index + 1;
      }

      await chrome.bookmarks.move(sourceId, { parentId: targetParentId, index: targetIndex });
      loadBookmarkTree();
    } catch (err) {
      console.error('拖拽移动失败:', err);
    }
  });
}

// 递归构建单个节点 DOM (绝对防崩设计)
function createNodeElement(node, depth = 0) {
  if (!node) return null;

  const isFolder = typeof node.url === 'undefined' && Array.isArray(node.children);
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';
  nodeEl.dataset.id = node.id || '';

  const sepInfo = parseSeparatorInfo(node.title);
  if (sepInfo) {
    const sepRow = document.createElement('div');
    sepRow.className = 'node-row ' + (sepInfo.type === 'pure' ? 'is-separator' : 'is-section-separator');
    sepRow.dataset.id = node.id;
    sepRow.title = `${node.title || '分割条'} (支持拖拽/右键修改/删除)`;
    
    if (sepInfo.type === 'pure') {
      sepRow.innerHTML = '<div class="separator-line" style="width:100%;height:1px;background:var(--border-color);margin:4px 0;"></div>';
    } else {
      sepRow.innerHTML = `<div class="section-line"></div><span class="section-text">${escapeHtml(sepInfo.text)}</span><div class="section-line"></div>`;
    }

    attachDragAndDropHandlers(sepRow, node);
    sepRow.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, node);
    });
    nodeEl.appendChild(sepRow);
    return nodeEl;
  }

  const rowEl = document.createElement('div');
  rowEl.className = 'node-row';
  rowEl.title = node.title || (node.url ? node.url : '未命名');
  attachDragAndDropHandlers(rowEl, node);

  if (isFolder) {
    const isExpanded = expandedFolders.has(node.id);
    if (isExpanded && node.id) {
      expandedFolders.add(node.id);
    }

    const hasChildren = node.children && node.children.length > 0;

    // 折叠展开箭头
    const arrowEl = document.createElement('span');
    arrowEl.className = `toggle-arrow ${isExpanded ? 'expanded' : ''} ${!hasChildren ? 'empty' : ''}`;
    arrowEl.innerHTML = ICONS.arrow;
    rowEl.appendChild(arrowEl);

    // 文件夹图标
    const iconWrapper = document.createElement('span');
    iconWrapper.innerHTML = ICONS.folder;
    rowEl.appendChild(iconWrapper.firstElementChild);

    // 文件夹名称
    const titleEl = document.createElement('span');
    titleEl.className = 'node-title';
    titleEl.textContent = node.title || '文件夹';
    rowEl.appendChild(titleEl);

    nodeEl.appendChild(rowEl);

    // 子项容器
    const childrenEl = document.createElement('div');
    childrenEl.className = `children-container ${isExpanded ? 'open' : ''}`;

    if (hasChildren) {
      const fragment = document.createDocumentFragment();
      for (const child of node.children) {
        const childNode = createNodeElement(child, depth + 1);
        if (childNode) fragment.appendChild(childNode);
      }
      childrenEl.appendChild(fragment);
    }

    nodeEl.appendChild(childrenEl);

    // 文件夹点击事件：展开/收起
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
    // 书签链接项
    const indentPlaceholder = document.createElement('span');
    indentPlaceholder.className = 'toggle-arrow empty';
    rowEl.appendChild(indentPlaceholder);

    // Favicon 图标 (带错误兜底)
    const imgEl = document.createElement('img');
    imgEl.className = 'item-icon';
    imgEl.src = getFaviconUrl(node.url);
    imgEl.onerror = () => {
      imgEl.replaceWith(createFallbackIcon());
    };
    rowEl.appendChild(imgEl);

    // 标题
    const titleEl = document.createElement('span');
    titleEl.className = 'node-title';
    titleEl.textContent = node.title || node.url;
    rowEl.appendChild(titleEl);

    nodeEl.appendChild(rowEl);

    // 点击打开书签
    rowEl.addEventListener('click', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        chrome.tabs.create({ url: node.url, active: false });
      } else {
        chrome.tabs.update({ url: node.url });
      }
    });

    // 鼠标中键打开
    rowEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) { // Middle click
        e.preventDefault();
        chrome.tabs.create({ url: node.url, active: false });
      }
    });

    // 右键菜单
    rowEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, node);
    });
  }

  return nodeEl;
}

function createFallbackIcon() {
  const span = document.createElement('span');
  span.innerHTML = ICONS.fileFallback;
  return span.firstElementChild;
}

// 加载并渲染书签树（完全安全的根解析）
async function loadBookmarkTree() {
  const container = document.getElementById('bookmark-container');
  try {
    const tree = await chrome.bookmarks.getTree();
    bookmarkTreeData = tree || [];

    container.innerHTML = '';
    const fragment = document.createDocumentFragment();

    const rootNodes = (tree && tree.length > 0 && tree[0].children) ? tree[0].children : tree;
    // 找到书签栏节点 (Chrome 默认 id 为 '1')
    const bookmarkBar = Array.isArray(rootNodes)
      ? (rootNodes.find(n => n.id === '1') || rootNodes[0])
      : null;

    const displayNodes = (bookmarkBar && Array.isArray(bookmarkBar.children))
      ? bookmarkBar.children
      : (Array.isArray(rootNodes) ? rootNodes : []);

    if (!displayNodes || displayNodes.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>书签栏暂无书签</p></div>';
      return;
    }

    for (const root of displayNodes) {
      const el = createNodeElement(root, 0);
      if (el) fragment.appendChild(el);
    }

    container.appendChild(fragment);
  } catch (error) {
    console.error('加载书签失败:', error);
    container.innerHTML = `<div class="empty-state"><p style="color:#d93025;">加载书签出错: ${error.message}</p></div>`;
  }
}

// 快速即时搜索
async function handleSearch(query) {
  const treeContainer = document.getElementById('bookmark-container');
  const resultsContainer = document.getElementById('search-results-container');
  const clearBtn = document.getElementById('clear-search');

  if (!query || query.trim() === '') {
    treeContainer.classList.remove('hidden');
    resultsContainer.classList.add('hidden');
    clearBtn.classList.add('hidden');
    return;
  }

  clearBtn.classList.remove('hidden');
  treeContainer.classList.add('hidden');
  resultsContainer.classList.remove('hidden');

  try {
    const results = await chrome.bookmarks.search(query.trim());
    resultsContainer.innerHTML = '';

    const bookmarkOnly = (results || []).filter(item => Boolean(item && item.url));

    if (bookmarkOnly.length === 0) {
      resultsContainer.innerHTML = `<div class="empty-state"><p>未找到匹配 "${escapeHtml(query)}" 的书签</p></div>`;
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
      titleEl.innerHTML = highlightMatch(item.title || item.url, query);
      infoEl.appendChild(titleEl);

      const urlEl = document.createElement('div');
      urlEl.className = 'search-item-url';
      urlEl.textContent = item.url;
      infoEl.appendChild(urlEl);

      itemEl.appendChild(infoEl);

      itemEl.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          chrome.tabs.create({ url: item.url, active: false });
        } else {
          chrome.tabs.update({ url: item.url });
        }
      });

      itemEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) chrome.tabs.create({ url: item.url, active: false });
      });

      itemEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, item);
      });

      fragment.appendChild(itemEl);
    }

    resultsContainer.appendChild(fragment);
  } catch (e) {
    console.error('搜索失败:', e);
  }
}

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
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  return escapeHtml(text).replace(regex, '<span class="highlight">$1</span>');
}

// 右键菜单
const contextMenu = document.getElementById('context-menu');

function showContextMenu(x, y, node) {
  activeContextMenuTarget = node;
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 150)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 150)}px`;
  contextMenu.classList.remove('hidden');
}

function hideContextMenu() {
  contextMenu.classList.add('hidden');
  activeContextMenuTarget = null;
}

document.addEventListener('click', () => hideContextMenu());

contextMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.menu-item');
  if (!item || !activeContextMenuTarget) return;

  const action = item.dataset.action;
  const url = activeContextMenuTarget.url;

  if (action === 'open-current') {
    chrome.tabs.update({ url });
  } else if (action === 'open-new-tab') {
    chrome.tabs.create({ url, active: true });
  } else if (action === 'open-bg-tab') {
    chrome.tabs.create({ url, active: false });
  } else if (action === 'copy-url') {
    navigator.clipboard.writeText(url);
  }

  hideContextMenu();
});

// 全部展开 / 全部折叠
document.getElementById('btn-expand-all').addEventListener('click', () => {
  document.querySelectorAll('.children-container').forEach(el => el.classList.add('open'));
  document.querySelectorAll('.toggle-arrow:not(.empty)').forEach(el => el.classList.add('expanded'));
  document.querySelectorAll('.tree-node').forEach(el => {
    if (el.dataset.id) expandedFolders.add(el.dataset.id);
  });
  saveExpandedState();
});

document.getElementById('btn-collapse-all').addEventListener('click', () => {
  document.querySelectorAll('.children-container').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('.toggle-arrow:not(.empty)').forEach(el => el.classList.remove('expanded'));
  expandedFolders.clear();
  saveExpandedState();
});

document.getElementById('btn-open-manager').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://bookmarks' });
});

// 搜索框防抖输入
const searchInput = document.getElementById('search-input');
let searchTimer = null;
searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => handleSearch(e.target.value), 150);
});

document.getElementById('clear-search').addEventListener('click', () => {
  searchInput.value = '';
  handleSearch('');
  searchInput.focus();
});

// 快捷键支持：Ctrl+F 聚焦搜索框
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// 监听书签事件，自动实时刷新
if (chrome.bookmarks && chrome.bookmarks.onCreated) {
  chrome.bookmarks.onCreated.addListener(() => loadBookmarkTree());
  chrome.bookmarks.onRemoved.addListener(() => loadBookmarkTree());
  chrome.bookmarks.onChanged.addListener(() => loadBookmarkTree());
  chrome.bookmarks.onMoved.addListener(() => loadBookmarkTree());
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  loadBookmarkTree();
});
