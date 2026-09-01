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

  // 如果是根面板且存在其他书签(id='2')且有子项，置于列表顶部
  if (depth === 0 && otherBookmarksNode && otherBookmarksNode.children && otherBookmarksNode.children.length > 0) {
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
    if (sepInfo) {
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

document.addEventListener('DOMContentLoaded', () => {
  loadBookmarkTree();
});
