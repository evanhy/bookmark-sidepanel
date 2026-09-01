// 极简书签弹窗 popup.js - 忠实还原 Popup my Bookmarks (PmB) 交互

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

function populatePanelList(listEl, folderNode, depth) {
  listEl.innerHTML = '';
  const children = folderNode.children || [];
  if (children.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-state';
    emptyEl.innerHTML = '<p>(空文件夹)</p>';
    listEl.appendChild(emptyEl);
    return;
  }

  for (const item of children) {
    const isFolder = !item.url;
    const itemEl = document.createElement('div');
    itemEl.className = 'pmb-item';
    itemEl.dataset.id = item.id;
    itemEl.title = item.title || (item.url ? item.url : '未命名');

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

      // 悬停逻辑
      itemEl.addEventListener('mouseenter', () => {
        if (isSearching) return;
        clearTimeout(hoverCloseTimer);
        clearTimeout(hoverOpenTimer);
        hoverOpenTimer = setTimeout(() => {
          listEl.querySelectorAll('.pmb-item').forEach(el => el.classList.remove('active'));
          itemEl.classList.add('active');
          appendCascadePanel(item, depth + 1);
        }, 50);
      });

      itemEl.addEventListener('click', (e) => {
        e.stopPropagation();
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
        hoverCloseTimer = setTimeout(() => {
          listEl.querySelectorAll('.pmb-item').forEach(el => el.classList.remove('active'));
          const panels = panelsContainer.querySelectorAll('.pmb-panel');
          panels.forEach(p => {
            if (parseInt(p.dataset.depth, 10) > depth) {
              p.remove();
            }
          });
          openCascadeFolderIds = openCascadeFolderIds.slice(0, depth);
        }, 140);
      });

      itemEl.addEventListener('click', (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          chrome.tabs.create({ url: item.url, active: false });
        } else {
          chrome.tabs.update({ url: item.url });
          window.close();
        }
      });

      itemEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          chrome.tabs.create({ url: item.url, active: false });
        }
      });
    }

    listEl.appendChild(itemEl);
  }
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

    const mgrBtn = document.createElement('button');
    mgrBtn.className = 'h-btn';
    mgrBtn.title = '打开原生书签管理器';
    mgrBtn.textContent = '⚙';
    mgrBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://bookmarks' });
      window.close();
    });
    toolsEl.appendChild(mgrBtn);

    headerEl.appendChild(toolsEl);
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
    searchInput.placeholder = '快速搜索书签...';
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
    // 恢复根面板书签树
    populatePanelList(rootList, bookmarkBarNode, 0);
    return;
  }

  isSearching = true;
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

  const rowEl = document.createElement('div');
  rowEl.className = 'node-row';
  rowEl.title = node.title || (node.url ? node.url : '未命名');

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
      if (e.ctrlKey || e.metaKey) {
        chrome.tabs.create({ url: node.url, active: false });
      } else {
        chrome.tabs.update({ url: node.url });
        window.close();
      }
    });

    rowEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        chrome.tabs.create({ url: node.url, active: false });
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
    renderTreeView();
    return;
  }

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
        if (e.ctrlKey || e.metaKey) {
          chrome.tabs.create({ url: item.url, active: false });
        } else {
          chrome.tabs.update({ url: item.url });
          window.close();
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
// 4. 右键菜单 (全局事件委托，确保所有层级子面板 100% 触发)
// ----------------------------------------------------
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

  if (type === 'folder') {
    const isRoot = node.id === '1' || (bookmarkBarNode && node.id === bookmarkBarNode.id);
    const renameItem = folderMenu.querySelector('[data-action="rename-folder"]');
    const deleteItem = folderMenu.querySelector('[data-action="delete-folder"]');
    if (renameItem) renameItem.style.display = isRoot ? 'none' : 'flex';
    if (deleteItem) deleteItem.style.display = isRoot ? 'none' : 'flex';
  }

  menu.classList.remove('hidden');

  const menuWidth = menu.offsetWidth || 175;
  const menuHeight = menu.offsetHeight || (type === 'folder' ? 190 : 250);

  const winWidth = window.innerWidth || document.documentElement.clientWidth || 500;
  const winHeight = window.innerHeight || document.documentElement.clientHeight || 520;

  let posX = x;
  let posY = y;

  if (posX + menuWidth > winWidth - 6) {
    posX = Math.max(6, winWidth - menuWidth - 6);
  }
  if (posY + menuHeight > winHeight - 6) {
    posY = Math.max(6, winHeight - menuHeight - 6);
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
        const isFolder = !node.url;
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
// 右键菜单动作响应
// ----------------------------------------------------
bookmarkMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.menu-item');
  if (!item || !activeContextMenuTarget) return;

  const action = item.dataset.action;
  const target = activeContextMenuTarget;
  hideContextMenu();

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
        if (target.parentId) ensureFolderInCascadePath(target.parentId);
        lastCreatedBookmarkId = target.id;
        loadBookmarkTree();
      }
    });
  } else if (action === 'delete-bookmark') {
    await chrome.bookmarks.remove(target.id);
    if (target.parentId) ensureFolderInCascadePath(target.parentId);
    loadBookmarkTree();
  }
});

folderMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.menu-item');
  if (!item || !activeContextMenuTarget) return;

  const action = item.dataset.action;
  const target = activeContextMenuTarget;
  hideContextMenu();

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
        const created = await chrome.bookmarks.create({ parentId: target.id, title: newTitle || '新建文件夹' });
        if (created) {
          lastCreatedBookmarkId = created.id;
          ensureFolderInCascadePath(target.id);
        }
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
        ensureFolderInCascadePath(target.parentId || target.id);
        lastCreatedBookmarkId = target.id;
        loadBookmarkTree();
      }
    });
  } else if (action === 'delete-folder') {
    if (confirm('确定要删除文件夹 "' + (target.title || '未命名') + '" 及其内部所有书签吗？')) {
      await chrome.bookmarks.removeTree(target.id);
      if (target.parentId) ensureFolderInCascadePath(target.parentId);
      loadBookmarkTree();
    }
  }
});

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

// 快捷键 Ctrl+F
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    const input = document.getElementById('cascade-search-input') || treeSearchInput;
    if (input) {
      input.focus();
      input.select();
    }
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

document.addEventListener('DOMContentLoaded', () => {
  loadBookmarkTree();
});
