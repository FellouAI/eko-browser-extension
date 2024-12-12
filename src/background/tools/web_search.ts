import { Tool, InputSchema } from "../../types/action.types";
import * as utils from "../utils";

/**
 * Web Search
 */
export class WebSearch implements Tool {
  name: string;
  description: string;
  input_schema: InputSchema;

  constructor() {
    this.name = "webSearch";
    this.description = "A web search tool";
    this.input_schema = {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "search for keywords",
        },
        maxResults: {
          type: "number",
          description: "Maximum search results, default 5",
        },
      },
      required: ["query"],
    };
  }

  /**
   * search
   *
   * @param {*} params { url: 'https://google.com', query: 'ai', maxResults: 5 }
   * @returns [{ title, url, content }]
   */
  async execute(params: unknown): Promise<unknown> {
    if (typeof params !== "object" || params === null || !("query" in params)) {
      throw new Error(
        'Invalid parameters. Expected an object with a "query" property.'
      )
    }
    let { url, query, maxResults } = params as any;
    if (!url) {
      url = "https://google.com";
    }
    let taskId = new Date().getTime() + "";
    let searchs = [{ url: url as string, keyword: query as string }];
    let searchInfo = await deepSearch(taskId, searchs, maxResults || 5);
    let links = searchInfo.result[0]?.links || [];
    return links.filter((s: any) => s.content);
  }
}

const deepSearchInjects: {
  [key: string]: { filename: string; buildSearchUrl: Function };
} = {
  "bing.com": {
    filename: "bing.js",
    buildSearchUrl: function (url: string, keyword: string) {
      return "https://bing.com/search?q=" + encodeURI(keyword);
    },
  },
  "duckduckgo.com": {
    filename: "duckduckgo.js",
    buildSearchUrl: function (url: string, keyword: string) {
      return "https://duckduckgo.com/?q=" + encodeURI(keyword);
    },
  },
  "google.com": {
    filename: "google.js",
    buildSearchUrl: function (url: string, keyword: string) {
      return "https://www.google.com/search?q=" + encodeURI(keyword);
    },
  },
  default: {
    filename: "google.js",
    buildSearchUrl: function (url: string, keyword: string) {
      url = url.trim();
      let idx = url.indexOf("//");
      if (idx > -1) {
        url = url.substring(idx + 2);
      }
      idx = url.indexOf("/", 2);
      if (idx > -1) {
        url = url.substring(0, idx);
      }
      keyword = "site:" + url + " " + keyword;
      return "https://www.google.com/search?q=" + encodeURIComponent(keyword);
    },
  },
};

function buildDeepSearchUrl(url: string, keyword: string) {
  let idx = url.indexOf("/", url.indexOf("//") + 2);
  let baseUrl = idx > -1 ? url.substring(0, idx) : url;
  let domains = Object.keys(deepSearchInjects);
  let inject = null;
  for (let j = 0; j < domains.length; j++) {
    let domain = domains[j];
    if (
      baseUrl == domain ||
      baseUrl.endsWith("." + domain) ||
      baseUrl.endsWith("/" + domain)
    ) {
      inject = deepSearchInjects[domain];
      break;
    }
  }
  if (!inject) {
    inject = deepSearchInjects["default"];
  }
  return {
    filename: inject.filename,
    url: inject.buildSearchUrl(url, keyword),
  };
}

// Event
const tabsUpdateEvent = new utils.MsgEvent();
chrome.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
  await tabsUpdateEvent.publish({ tabId, changeInfo, tab });
});

/**
 * deep search
 *
 * @param {string} taskId task id
 * @param {array} searchs search list => [{ url: 'https://bing.com', keyword: 'ai' }]
 * @param {number} detailsMaxNum Maximum crawling quantity per search detail page
 */
async function deepSearch(
  taskId: string,
  searchs: Array<{ url: string; keyword: string }>,
  detailsMaxNum: number,
  window?: chrome.windows.Window
) {
  let closeWindow = false;
  if (!window) {
    // open new window
    window = await chrome.windows.create({
      type: "normal",
      state: "maximized",
      url: null,
    } as any as chrome.windows.CreateData);
    closeWindow = true;
  }
  // crawler the search page details page link
  // [{ links: [{ title, url }] }]
  let detailLinkGroups = await doDetailLinkGroups(
    taskId,
    searchs,
    detailsMaxNum,
    window
  );
  // crawler all details page content and comments
  let searchInfo = await doPageContent(taskId, detailLinkGroups, window);
  console.log("searchInfo: ", searchInfo);
  // close window
  closeWindow && chrome.windows.remove(window.id as number);
  return searchInfo;
}

/**
 * crawler the search page details page link
 *
 * @param {string} taskId task id
 * @param {array} searchs search list => [{ url: 'https://bing.com', keyword: 'ai' }]
 * @param {number} detailsMaxNum Maximum crawling quantity per search detail page
 * @param {*} window
 * @returns [{ links: [{ title, url }] }]
 */
async function doDetailLinkGroups(
  taskId: string,
  searchs: Array<{ url: string; keyword: string }>,
  detailsMaxNum: number,
  window: chrome.windows.Window
) {
  let detailLinkGroups = [] as Array<any>;
  let countDownLatch = new utils.CountDownLatch(searchs.length);
  for (let i = 0; i < searchs.length; i++) {
    try {
      // script name & build search URL
      const { filename, url } = buildDeepSearchUrl(
        searchs[i].url,
        searchs[i].keyword
      );
      // open new Tab
      let tab = await chrome.tabs.create({
        url: url,
        windowId: window.id,
      });
      let eventId = taskId + "_" + i;
      // monitor Tab status
      tabsUpdateEvent.addListener(async function (obj: any) {
        if (obj.tabId != tab.id) {
          return;
        }
        if (obj.changeInfo.status === "complete") {
          tabsUpdateEvent.removeListener(eventId);
          // inject js
          await utils.injectScript(tab.id as number, filename);
          await utils.sleep(1000);
          // crawler the search page details page
          // { links: [{ title, url }] }
          let detailLinks: any = await chrome.tabs.sendMessage(
            tab.id as number,
            { type: "page:getDetailLinks", keyword: searchs[i].keyword }
          );
          if (!detailLinks || !detailLinks.links) {
            // TODO error
            detailLinks = { links: [] };
          }
          console.log("detailLinks: ", detailLinks);
          let links = detailLinks.links.slice(0, detailsMaxNum);
          detailLinkGroups.push({ url, links, filename });
          countDownLatch.countDown();
          chrome.tabs.remove(tab.id as number);
        } else if (obj.changeInfo.status === "unloaded") {
          countDownLatch.countDown();
          chrome.tabs.remove(tab.id as number);
          tabsUpdateEvent.removeListener(eventId);
        }
      }, eventId);
    } catch (e) {
      console.error(e);
      countDownLatch.countDown();
    }
  }
  await countDownLatch.await(30_000);
  return detailLinkGroups;
}

/**
 * page content
 *
 * @param {string} taskId task id
 * @param {array} detailLinkGroups details page group
 * @param {*} window
 * @returns search info
 */
async function doPageContent(
  taskId: string,
  detailLinkGroups: Array<any>,
  window: chrome.windows.Window
) {
  const searchInfo: any = {
    total: 0,
    running: 0,
    succeed: 0,
    failed: 0,
    failedLinks: [],
    result: detailLinkGroups,
  };
  for (let i = 0; i < detailLinkGroups.length; i++) {
    let links = detailLinkGroups[i].links;
    searchInfo.total += links.length;
  }
  let countDownLatch = new utils.CountDownLatch(searchInfo.total);
  for (let i = 0; i < detailLinkGroups.length; i++) {
    let filename = detailLinkGroups[i].filename;
    let links = detailLinkGroups[i].links;
    for (let j = 0; j < links.length; j++) {
      let link = links[j];
      // open new tab
      let tab = await chrome.tabs.create({
        url: link.url,
        windowId: window.id,
      });
      searchInfo.running++;
      let eventId = taskId + "_" + i + "_" + j;
      // monitor Tab status
      tabsUpdateEvent.addListener(async function (obj: any) {
        if (obj.tabId != tab.id) {
          return;
        }
        if (obj.changeInfo.status === "complete") {
          try {
            tabsUpdateEvent.removeListener(eventId);
            // inject js
            await utils.injectScript(tab.id as number, filename);
            await utils.sleep(1000);
            // cralwer content and comments
            // { title, content }
            let result: any = await chrome.tabs.sendMessage(tab.id as number, {
              type: "page:getContent",
            });
            if (!result) {
              throw Error("No Result");
            }
            link.content = result.content;
            link.page_title = result.title;
            searchInfo.succeed++;
          } catch (e) {
            searchInfo.failed++;
            searchInfo.failedLinks.push(link);
            console.error(link.title + " crawler error", link.url, e);
          } finally {
            searchInfo.running--;
            countDownLatch.countDown();
            chrome.tabs.remove(tab.id as number);
            tabsUpdateEvent.removeListener(eventId);
          }
        } else if (obj.changeInfo.status === "unloaded") {
          searchInfo.running--;
          countDownLatch.countDown();
          chrome.tabs.remove(tab.id as number);
          tabsUpdateEvent.removeListener(eventId);
        }
      }, eventId);
    }
  }
  await countDownLatch.await(60_000);
  return searchInfo;
}
