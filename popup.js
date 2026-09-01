// 极简书签弹窗 popup.js

let bookmarkTreeData = [];
let expandedFolders = new Set(JSON.parse(localStorage.getItem('expanded_folders_') || '[]'));
let activeContextMenuTarget = null; // 当前右键选中的节点
let activeContextMenuType = null;   // 'bookmark' 或 'folder'
let modalCallback = null;

// Favicon URL 解析器
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

function saveExpandedState() {
  try {
    localStorage.setItem('expanded_folders_', JSON.stringify(Array.from(expandedFolders)));
  } catch (e) {
    console.warn('无法保存状态到 localStorage', e);
  }
}

// 递归构建单个节点 DOM (绝对防崩设计)
function createNodeElement(node, depth = 0) {
  if (!node) return null;

  const isFolder = !node.url && Array.isArray(node.children);
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';
  nodeEl.dataset.id = node.id || '';

  const rowEl = document.createElement('div');
  rowEl.className = 'node-row';
  rowEl.title = node.title || (node.url ? node.url : '未命名');

  if (isFolder) {
    const isExpanded = expandedFolders.has(node.id) || (depth === 0 && expandedFolders.size === 0);
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

    // 文件夹右键菜单
    rowEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, node, 'folder');
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
        window.close();
      }
    });

    // 鼠标中键打开
    rowEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        chrome.tabs.create({ url: node.url, active: false });
      }
    });

    // 书签右键菜单
    rowEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, node, 'bookmark');
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

    if (!rootNodes || rootNodes.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>暂无书签</p></div>';
      return;
    }

    for (const root of rootNodes) {
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
          window.close();
        }
      });

      itemEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) chrome.tabs.create({ url: item.url, active: false });
      });

      itemEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, item, 'bookmark');
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

// 递归提取文件夹下的所有书签 URL
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

// 右键菜单元素
const bookmarkMenu = document.getElementById('bookmark-context-menu');
const folderMenu = document.getElementById('folder-context-menu');

// 全局拦截默认右键菜单
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

function showContextMenu(x, y, node, type) {
  hideContextMenu();
  activeContextMenuTarget = node;
  activeContextMenuType = type;

  const menu = type === 'folder' ? folderMenu : bookmarkMenu;
  const menuWidth = 190;
  const menuHeight = type === 'folder' ? 200 : 260;

  const posX = Math.min(x, window.innerWidth - menuWidth - 8);
  const posY = Math.min(y, window.innerHeight - menuHeight - 8);

  menu.style.left = `${Math.max(4, posX)}px`;
  menu.style.top = `${Math.max(4, posY)}px`;
  menu.classList.remove('hidden');
}

function hideContextMenu() {
  bookmarkMenu.classList.add('hidden');
  folderMenu.classList.add('hidden');
}

// 捕获阶段监听全局点击：只要点击在右键菜单外部，立即关闭右键菜单（不受 stopPropagation 影响）
document.addEventListener('pointerdown', (e) => {
  if (!bookmarkMenu.contains(e.target) && !folderMenu.contains(e.target)) {
    hideContextMenu();
  }
}, true);

// 滚动时或按 Escape 时也自动关闭右键菜单
window.addEventListener('scroll', () => hideContextMenu(), true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editModal.classList.contains('hidden')) {
    hideContextMenu();
  }
});


// 书签右键菜单事件响应
bookmarkMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.menu-item');
  if (!item || !activeContextMenuTarget) return;

  const action = item.dataset.action;
  const target = activeContextMenuTarget;

  if (action === 'open-current') {
    chrome.tabs.update({ url: target.url });
    window.close();
  } else if (action === 'open-new-tab') {
    chrome.tabs.create({ url: target.url, active: true });
    window.close();
  } else if (action === 'open-bg-tab') {
    chrome.tabs.create({ url: target.url, active: false });
  } else if (action === 'open-incognito') {
    chrome.windows.create({ url: target.url, incognito: true });
    window.close();
  } else if (action === 'copy-url') {
    navigator.clipboard.writeText(target.url);
  } else if (action === 'edit-bookmark') {
    showEditModal({
      title: '编辑书签',
      initialTitle: target.title || '',
      initialUrl: target.url || '',
      showUrl: true,
      onSave: async (newTitle, newUrl) => {
        await chrome.bookmarks.update(target.id, { title: newTitle, url: newUrl });
        loadBookmarkTree();
      }
    });
  } else if (action === 'delete-bookmark') {
    await chrome.bookmarks.remove(target.id);
    loadBookmarkTree();
  }

  hideContextMenu();
});

// 文件夹右键菜单事件响应
folderMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.menu-item');
  if (!item || !activeContextMenuTarget) return;

  const action = item.dataset.action;
  const target = activeContextMenuTarget;

  // 获取完整子节点树
  const fullSubTree = (await chrome.bookmarks.getSubTree(target.id))[0];
  const allUrls = extractUrls(fullSubTree);

  if (action === 'open-all-tabs') {
    for (const u of allUrls) {
      chrome.tabs.create({ url: u, active: false });
    }
  } else if (action === 'open-all-window') {
    if (allUrls.length > 0) {
      chrome.windows.create({ url: allUrls });
      window.close();
    }
  } else if (action === 'new-folder') {
    showEditModal({
      title: '新建子文件夹',
      initialTitle: '',
      showUrl: false,
      onSave: async (newTitle) => {
        await chrome.bookmarks.create({ parentId: target.id, title: newTitle || '新建文件夹' });
        expandedFolders.add(target.id);
        saveExpandedState();
        loadBookmarkTree();
      }
    });
  } else if (action === 'rename-folder') {
    showEditModal({
      title: '重命名文件夹',
      initialTitle: target.title || '',
      showUrl: false,
      onSave: async (newTitle) => {
        await chrome.bookmarks.update(target.id, { title: newTitle || target.title });
        loadBookmarkTree();
      }
    });
  } else if (action === 'delete-folder') {
    if (confirm(`确定要删除文件夹 "${target.title || '未命名'}" 及其内部所有书签吗？`)) {
      await chrome.bookmarks.removeTree(target.id);
      expandedFolders.delete(target.id);
      saveExpandedState();
      loadBookmarkTree();
    }
  }

  hideContextMenu();
});

// 模态编辑对话框
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

// 模态框快捷键：Enter 确认保存，Escape 取消
editModal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btn-modal-save').click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeEditModal();
  }
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
  window.close();
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

