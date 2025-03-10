browser.userScripts.onBeforeScript.addListener(script => {
  // --- globals
  const {grantRemove, registerMenuCommand, remoteCSS, resourceData, FMUrl, info} = script.metadata;
  const {name, id = `_${name}`, injectInto, resources} = info.script; // set id as _name
  let {storage} = script.metadata;                          // storage at the time of registration
  const valueChange = {};
  const scriptCommand = {};
  // const FMUrl = browser.runtime.getURL('');                 // used for sourceURL & import

  // --- add isIncognito to GM info
  if (browser.extension.inIncognitoContext) {
    info.isIncognito = true;
    info.script.isIncognito = true;
  }

  class API {

    static {
      // Script Command registerMenuCommand
      registerMenuCommand && browser.runtime.onMessage.addListener(message => {
        switch (true) {
          case Object.hasOwn(message, 'listCommand'):       // to popup.js
            const command = Object.keys(scriptCommand);
            command[0] && browser.runtime.sendMessage({name, command});
            break;

          case message.name === name && Object.hasOwn(message, 'command'): // from popup.js
            (scriptCommand[message.command])();
            break;
        }
      });
    }

    // --- Script Storage: direct operation
    static async getData() {
      return (await browser.storage.local.get(id))[id];
    }

    static async setStorage() {
      const data = await API.getData();
      storage = data.storage;
    }

    static onChanged(changes) {
      if (!changes[id]) { return; }                         // not this userscript
      const oldValue = changes[id].oldValue.storage;
      const newValue = changes[id].newValue.storage;
      // process addValueChangeListener (only for remote) (key, oldValue, newValue, remote)
      Object.keys(valueChange).forEach(item =>
         !API.equal(oldValue[item], newValue[item]) &&
          (valueChange[item])(item, oldValue[item], newValue[item], !API.equal(newValue[item], storage[item]))
      );
    }

    static equal(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    // based on browser.storage.local.get()
    // A key (string) or keys (an array of strings, or an object specifying default values)
    // to identify the item(s) to be retrieved from storage. If you pass an empty object or array here,
    // an empty object will be retrieved. If you pass null, or an undefined value,
    // the entire storage contents will be retrieved.
    static getStorageValue(thisStorage, key, defaultValue) {
      let obj = {};
      switch (true) {
        case !key:
          obj = thisStorage;
          break;

        case typeof key === 'string':
          obj = Object.hasOwn(thisStorage, key) ? thisStorage[key] : defaultValue;
          break;

        case Array.isArray(key):
          key.forEach(i => obj[i] = thisStorage[i]);
          break;

        default:
          Object.entries(key).forEach(([item, def]) =>
            obj[item] = Object.hasOwn(thisStorage, item) ? thisStorage[item] : def);
      }

      return API.prepare(obj);                              // object or string
    }

    // --- synch APIs
    static GM_getValue(key, defaultValue) {
      return API.getStorageValue(storage, key, defaultValue);
    }

    static GM_listValues() {
      return script.export(Object.keys(storage));
    }

    static GM_getResourceText(resourceName) {
      return resourceData[resourceName] || '';
    }

    // --- sync return GM_getResourceURL
    static getResourceUrl(resourceName) {
      return resources[resourceName];
    }

    // --- prepare return value, check if it is primitive value
    static prepare(value) {
      return ['object', 'function'].includes(typeof value) && value !== null ? script.export(value) : value;
    }

    // --- auxiliary regex include/exclude test function
    static matchURL() {
      const {includes, excludes} = info.script;
      return (!includes[0] || API.arrayTest(includes)) && (!excludes[0] || !API.arrayTest(excludes));
    }

    static arrayTest(arr, url = location.href) {
      return arr.some(i => new RegExp(i.slice(1, -1), 'i').test(url));
    }

    // --- cloneInto wrapper for object methods
    static cloneIntoBridge(obj, target, options = {}) {
      return cloneInto(options.cloneFunctions ? obj.wrappedJSObject : obj, target, options);
    }

    // --- inject into page context
    static injectIntoPage(str) {
      str = `((unsafeWindow, GM, GM_info = GM.info) => {(() => { ${str}
})();})(window, ${JSON.stringify({info})});`;
      GM.addScript(str);
    }

    // --- log from background
    static log(message, type = 'error') {
      browser.runtime.sendMessage({
        api: 'log',
        name,
        data: {message, type}
      });
    }

    static checkURL(url) {
      try { url = new URL(url, location.href); }
      catch (error) {
        API.log(`checkURL ${url} ➜ ${error.message}`);
        return;
      }

      // check protocol
      if (!['http:', 'https:', 'blob:'].includes(url.protocol)) {
        API.log(`checkURL ${url} ➜ Unsupported Protocol ${url.protocol}`);
        return;
      }
      return url.href;
    }

    // --- prepare request headers
    static prepareInit(init) {
      // --- remove forbidden headers (Attempt to set a forbidden header was denied: Referer), allow specialHeader
      const specialHeader = ['cookie', 'host', 'origin', 'referer'];
      const forbiddenHeader = ['accept-charset', 'accept-encoding', 'access-control-request-headers',
        'access-control-request-method', 'connection', 'content-length', 'cookie2', 'date', 'dnt', 'expect',
        'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via'];

      init.headers ||= {};                                  // check init.headers
      Object.keys(init.headers).forEach(item => {
        const LC = item.toLowerCase();
        if (LC.startsWith('proxy-') || LC.startsWith('sec-') || forbiddenHeader.includes(LC)) {
          delete init.headers[item];
        }
        else if (specialHeader.includes(LC)) {
          const name = LC.charAt(0).toUpperCase() + LC.substring(1); // fix case
          init.headers[item] && (init.headers[`FM-${name}`] = init.headers[item]); // set a new FM header
          delete init.headers[item];                        // delete original header
        }
      });

      delete init.anonymous;                                // clean up
    }

    // ---------- import -----------------------------------
    // Support loading content scripts as ES6 modules
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1451545
    // GM.import() -> importBridge()
    // internal modules && images
    // get response.blob() with original type
    static async importBridge(url) {
      // --- internal module
      const mod = {
        PSL: `${FMUrl}content/psl.js`
      };
      if (mod[url]) {
        return fetch(mod[url])
        .then(response => response.blob())
        .then(blob => URL.createObjectURL(blob));
      }

      // --- remote import
      url = API.checkURL(url);
      if (!url) { return; }

      return GM.fetch(url, {responseType: 'blob'})
      .then(response => response?.blob && URL.createObjectURL(response.blob));
    }
    // ---------- /import ----------------------------------

    // ---------- xmlHttpRequest callback ------------------
    /*
      Ref: Rob Wu (robwu)
      In order to make callback functions visible
      ONLY for GM.xmlHttpRequest(GM_xmlhttpRequest)
    */
    static userScriptCallback(object, name, ...args) {
      try {
        const cb = object.wrappedJSObject[name];
        typeof cb === 'function' && cb(...args);
      }
      catch (error) {
        API.log(`userScriptCallback ➜ ${error.message}`);
      }
    }
  }

  // ---------- GM4 Object based functions -----------------
  const GM = {

    // ---------- storage ----------------------------------
    async getValue(key, defaultValue) {
      const data = await API.getData();
      return API.getStorageValue(data.storage, key, defaultValue);
    },

    // based on browser.storage.local.set()
    // An object containing one or more key/value pairs to be stored in storage.
    // If an item already exists, its value will be updated.
    async setValue(key, value) {
      if (!key) { return; }

      const obj = typeof key === 'string' ? {[key]: value} : key; // change to object

      // update sync storage
      Object.entries(obj).forEach(([key, value]) => storage[key] = value);

      // update async storage
      return browser.runtime.sendMessage({
        api: 'setValue',
        name,
        data: obj
      });
    },

    // based on browser.storage.local.remove()
    // A string, or array of strings, representing the key(s) of the item(s) to be removed.
    async deleteValue(key) {
      if (!key) { return; }

      const arr = Array.isArray(key) ? key : [key];         // change to array

      // update sync storage
      arr.forEach(i => delete storage[i]);

      // update async storage
      return browser.runtime.sendMessage({
        api: 'deleteValue',
        name,
        data: arr
      });
    },

    async listValues() {
      const data = await API.getData();
      const value = Object.keys(data.storage);
      return script.export(value);
    },

    addValueChangeListener(key, callback) {
      browser.storage.onChanged.addListener(API.onChanged);
      valueChange[key] = callback;
      return key;
    },

    removeValueChangeListener(key) {
      delete valueChange[key];
    },
    // ---------- /storage ---------------------------------

    // ---------- other background functions ---------------
    download(url, filename) {
      // --- check url
      url = API.checkURL(url);
      if (!url) { return Promise.reject(); }

      return browser.runtime.sendMessage({
        api: 'download',
        name,
        data: {url, filename}
      });
    },

    notification(text, title, image, onclick) {
      // GM|TM|VM: (text, title, image, onclick)
      // TM|VM: {text, title, image, onclick}
      const txt = text?.text || text;
      if (typeof txt !== 'string' || !txt.trim()) { return; }
      return browser.runtime.sendMessage({
        api: 'notification',
        name,
        data: typeof text === 'string' ? {text, title, image, onclick} : text
      });
    },

    // opt = open_in_background
    async openInTab(url, opt) {
      // GM opt: boolean
      // TM|VM opt: boolean OR object {active: true/false}
      const active = typeof opt === 'object' ? !!opt.active : !opt;
      // Error: Return value not accessible to the userScript
      // resolve -> tab object | reject -> undefined
      const tab = await browser.runtime.sendMessage({
        api: 'openInTab',
        name,
        data: {url, active}
      });
      return !!tab; // true/false
    },

    // As the API is only available to Secure Contexts, it cannot be used from
    // a content script running on http:-pages, only https:-pages.
    // See also: https://github.com/w3c/webextensions/issues/378
    setClipboard(data, type) {
      // VM type: string MIME type e.g. 'text/plain'
      // TM type: string e.g. 'text' or 'html'
      // TM type: object e.g. {type: 'text', mimetype: 'text/plain'}
      type = type?.mimetype || type?.type || type || 'text/plain'; // defaults to 'text/plain'

      // fix short type
      if (type === 'text') { type = 'text/plain'; }
      else if (type === 'html') { type = 'text/html'; }

      return browser.runtime.sendMessage({
        api: 'setClipboard',
        name,
        data: {data, type}
      });
    },

    async fetch(url, init = {}) {
      // check url
      url &&= API.checkURL(url);
      if (!url) { return; }

      const data = {
        url,
        init: {headers: {}}
      };

      ['method', 'headers', 'body', 'mode', 'credentials', 'cache', 'redirect',
        'referrer', 'referrerPolicy', 'integrity', 'keepalive', 'signal',
        'responseType'].forEach(i => Object.hasOwn(init, i) && (data.init[i] = init[i]));

      // exclude credentials in request, ignore credentials sent back in response (e.g. Set-Cookie header)
      init.anonymous && (data.init.credentials = 'omit');

      API.prepareInit(data.init);

      const response = await browser.runtime.sendMessage({
        api: 'fetch',
        name,
        data
      });

      // cloneInto() work around for https://bugzilla.mozilla.org/show_bug.cgi?id=1583159
      return response ? cloneInto(response, window) : undefined;
    },

    async xmlHttpRequest(init = {}) {
      // check url
      const url = init.url && API.checkURL(init.url);
      if (!url) { return; }

      const data = {
        method: 'GET',
        url,
        data: null,
        user: null,
        password: null,
        responseType: '',
        headers: {},
        mozAnon: !!init.anonymous
      };

      // not processing withCredentials as it has no effect from bg script
      ['method', 'headers', 'data', 'overrideMimeType', 'user', 'password', 'timeout',
        'responseType'].forEach(i => Object.hasOwn(init, i) && (data[i] = init[i]));

      API.prepareInit(data);

      const response = await browser.runtime.sendMessage({
        api: 'xmlHttpRequest',
        name,
        data
      });
      if (!response) { throw 'There was an error with the xmlHttpRequest request.'; }

      // only these 4 callback functions are processed
      // cloneInto() work around for https://bugzilla.mozilla.org/show_bug.cgi?id=1583159
      const type = response.type;
      delete response.type;
      // convert text responseXML to XML DocumentFragment
      response.responseXML &&= document.createRange().createContextualFragment(response.responseXML.trim());
      API.userScriptCallback(init, type,
         typeof response.response === 'string' ? script.export(response) : cloneInto(response, window));
    },
    // ---------- /other background functions --------------

    // ---------- DOM functions ----------------------------
    addStyle(str) {
      str.trim() && GM.addElement('style', {textContent: str});
    },

    addScript(str) {
      str.trim() && GM.addElement('script', {textContent: str});
    },

    addElement(parent, tag, attr) {
      if (!parent || !tag) { return; }
      // mapping (tagName, attributes) vs (parentElement, tagName, attributes)
      let parentElement = attr && parent;
      const tagName = (attr ? tag : parent).toLowerCase();
      const attributes = attr || tag;
      const script = tagName === 'script';

      switch (true) {
        case !!parentElement:
          break;

        case ['link', 'meta'].includes(tagName):
          parentElement = document.head || document.body;
          break;

        case ['script', 'style'].includes(tagName):
          parentElement = document.head || document.body || document.documentElement || document;
          break;

        default:
          parentElement = document.body || document.documentElement || document;
      }

      const elem = document.createElement(tagName);
      elem.dataset.src = `${name}.user.js`;
      Object.entries(attributes)?.forEach(([key, value]) =>
        key === 'textContent' ? elem.append(value) : elem.setAttribute(key, value));

      // script only
      if (script && attributes.textContent && injectInto !== 'page') {
        elem.textContent +=
          `\n\n//# sourceURL=${FMUrl}userscript/${encodeURI(name)}/inject-into-page/${Math.random().toString(36).substring(2)}.js`;
      }

      try {
        const el = parentElement.appendChild(elem);
        script && el.remove();
        // userscript may record UUID in element's textContent
        return script ? undefined : elem;
      }
      catch (error) { API.log(`addElement ➜ ${tagName} ${error.message}`); }
    },

    popup({type = 'center', modal = true} = {}) {
      const host = document.createElement('gm-popup');      // shadow DOM host
      const shadow = host.attachShadow({mode: 'closed'});   // closed: inaccessible from the outside

      const style = document.createElement('style');
      style.textContent = `@import "${FMUrl}content/api-popup.css";`;
      shadow.appendChild(style);

      const content = document.createElement('div');        // main content
      content.className = 'content';
      shadow.appendChild(content);

      const close = document.createElement('span');         // close button
      close.className = 'close';
      close.textContent = '✖';
      content.appendChild(close);

      [host, content].forEach(i => i.classList.add(type)); // process options
      host.classList.toggle('modal', type.startsWith('panel-') ? modal : true); // process modal
      document.body.appendChild(host);

      const obj = {
        host,
        style,
        content,
        close,

        addStyle(css) {
          style.textContent += '\n\n' + css;
        },

        append(...arg) {
          typeof arg[0] === 'string' && /^<.+>$/.test(arg[0].trim()) ?
            content.append(document.createRange().createContextualFragment(arg[0].trim())) :
              content.append(...arg);
        },

        show() {
          host.style.opacity = 1;
          host.classList.add('on');
        },

        hide(e) {
          if (!e || [host, close].includes(e.originalTarget)) {
            host.style.opacity = 0;
            setTimeout(() => host.classList.remove('on'), 500);
          }
        },

        remove() {
          host.remove();
        }
      };

      host.addEventListener('click', obj.hide);

      return script.export(obj);
    },
    // ---------- /DOM functions ---------------------------

    // ---------- import -----------------------------------
    createObjectURL(val, option = {type: 'text/javascript'}) {
      const blob = new Blob([val], {type: option.type});
      return URL.createObjectURL(blob);
    },
    // ---------- /import ----------------------------------

    // --- async promise return GM.getResourceText
    async getResourceText(resourceName) {
      return resourceData[resourceName] || '';
    },

    // --- async Promise return GM.getResourceUrl
    async getResourceUrl(resourceName) {
      return resources[resourceName];
    },

    registerMenuCommand(text, onclick, accessKey) {
      scriptCommand[text] = onclick;
    },

    unregisterMenuCommand(text) {
      delete scriptCommand[text];
    },

    log(...text) {
      // eslint-disable-next-line no-console
      console.log(`${name}:`, ...text);
    },

    info,
  };

  /* eslint-disable @stylistic/js/key-spacing */
  const globals = {
    GM,

    // background functions
    GM_download:                  GM.download,
    GM_fetch:                     GM.fetch,
    GM_notification:              GM.notification,
    GM_openInTab:                 GM.openInTab,
    GM_setClipboard:              GM.setClipboard,
    GM_xmlhttpRequest:            GM.xmlHttpRequest,        // http -> Http

    // Storage
    GM_getValue:                  API.GM_getValue,
    GM_setValue:                  GM.setValue,
    GM_deleteValue:               GM.deleteValue,
    GM_listValues:                API.GM_listValues,

    // DOM functions
    GM_addElement:                GM.addElement,
    GM_addScript:                 GM.addScript,
    GM_addStyle:                  GM.addStyle,
    GM_popup:                     GM.popup,

    // other
    GM_getResourceText:           API.GM_getResourceText,
    GM_getResourceURL:            API.getResourceUrl,       // URL -> Url
    GM_addValueChangeListener:    GM.addValueChangeListener,
    GM_removeValueChangeListener: GM.removeValueChangeListener,
    GM_registerMenuCommand:       GM.registerMenuCommand,
    GM_unregisterMenuCommand:     GM.unregisterMenuCommand,
    GM_createObjectURL:           GM.createObjectURL,
    GM_info:                      GM.info,
    GM_log:                       GM.log,

    // Firefox functions
    cloneInto:                    API.cloneIntoBridge,
    exportFunction,

    // internal use
    matchURL:                     API.matchURL,
    setStorage:                   API.setStorage,
    importBridge:                 API.importBridge,
    injectIntoPage:               API.injectIntoPage,
  };

  // auto-disable sync GM API if async GM API are granted
  grantRemove.forEach(i => delete globals[i]);

  // --- check @require CSS
  remoteCSS.forEach(i => GM.addElement('link', {href: i, rel: 'stylesheet'}));

  script.defineGlobals(globals);
});