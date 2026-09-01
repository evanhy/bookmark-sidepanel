// background.js

// 1. 设置点击图标直接呼出原生侧边栏 (Chrome 116+)
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.log("setPanelBehavior info:", err));
}

// 2. 双重保障：监听点击事件，显式呼出侧边栏
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.windowId && chrome.sidePanel && chrome.sidePanel.open) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
      console.error("无法打开侧边栏:", err);
    });
  }
});

