/**
 * Background Service Worker
 * 
 * - 최초 설치 시 welcome 페이지 자동 오픈
 * - 업데이트 시에는 오픈하지 않음
 */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('src/welcome.html'),
      active: true
    });
  }
});
