/**
 * Stealth overrides injected into the main world (what websites see) before
 * page scripts run. This makes the Electron browser appear as a regular Chrome
 * browser to anti-bot/fingerprinting checks while identifying as Clodex.
 *
 * Must be called from a preload script. The injection uses a synchronous
 * `<script>` element on `document.documentElement` so it executes in the
 * main world before any page JavaScript.
 */
export function injectStealthOverrides(): void {
  // Skip injection on internal pages
  try {
    if (window.location.protocol === 'clodex:') return;
  } catch {
    // If location access fails, skip injection
    return;
  }

  const chromeMajor = process.versions.chrome.split('.')[0];

  const platformName =
    process.platform === 'darwin'
      ? 'macOS'
      : process.platform === 'win32'
        ? 'Windows'
        : 'Linux';

  // Build the clean UA string (must match what session.setUserAgent() uses)
  let platformUA: string;
  switch (process.platform) {
    case 'darwin':
      platformUA =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
      break;
    case 'win32':
      platformUA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)';
      break;
    default:
      platformUA =
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)';
      break;
  }
  const cleanUserAgent = `${platformUA} Chrome/${chromeMajor}.0.0.0 Safari/537.36`;

  // Build the script to inject into the main world
  const script = document.createElement('script');
  script.textContent = buildStealthScript(
    chromeMajor,
    platformName,
    cleanUserAgent,
  );

  const inject = () => {
    document.documentElement.prepend(script);
    script.remove();
  };

  // Preload scripts run before the DOM exists, so document.documentElement
  // is typically null at this point. Use a MutationObserver to inject as
  // soon as it's created — the observer fires synchronously during DOM
  // construction, guaranteeing our script runs before any page <script> tags.
  if (document.documentElement) {
    inject();
  } else {
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        inject();
      }
    });
    observer.observe(document, { childList: true });
  }
}

function buildStealthScript(
  chromeMajor: string,
  platformName: string,
  cleanUserAgent: string,
): string {
  // The script runs in the main world — it must be a self-contained string.
  // We interpolate values from the preload context.
  return `(function() {
  'use strict';

  // 0. Remove window.process — BotD checks process.type === 'renderer'
  // and process.versions.electron to identify Electron apps.
  // Electron may leak a process object into the main world.
  try {
    if (typeof window.process !== 'undefined') {
      var _origProcess = window.process;
      try { delete window.process; } catch(e) {}
      // If delete didn't work (non-configurable), shadow with undefined
      if (typeof window.process !== 'undefined') {
        Object.defineProperty(window, 'process', {
          value: undefined,
          writable: false,
          configurable: true,
        });
      }
    }
  } catch(e) {}

  // 1. Override navigator.userAgent and navigator.appVersion on both
  // instance and prototype. BotD checks both for /Electron/i.
  try {
    var uaGetter = { get: function() { return '${cleanUserAgent}'; }, configurable: true };
    Object.defineProperty(navigator, 'userAgent', uaGetter);
    Object.defineProperty(Navigator.prototype, 'userAgent', uaGetter);
  } catch(e) {}
  // appVersion is the UA string minus the "Mozilla/" prefix
  try {
    var avValue = '${cleanUserAgent}'.replace(/^Mozilla\\//, '');
    var avGetter = { get: function() { return avValue; }, configurable: true };
    Object.defineProperty(navigator, 'appVersion', avGetter);
    Object.defineProperty(Navigator.prototype, 'appVersion', avGetter);
  } catch(e) {}

  // 2. Mock window.chrome (Chrome runtime object)
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      writable: true,
      enumerable: true,
      configurable: true,
      value: {},
    });
  }
  var c = window.chrome;
  if (!c.runtime) {
    c.runtime = {
      connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {} }; },
      sendMessage: function() {},
      onMessage: { addListener: function() {}, removeListener: function() {} },
      id: undefined,
    };
  }
  if (!c.app) {
    c.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: function() { return null; },
      getIsInstalled: function() { return false; },
      runningState: function() { return 'cannot_run'; },
    };
  }
  if (!c.csi) {
    c.csi = function() { return {}; };
  }
  if (!c.loadTimes) {
    c.loadTimes = function() {
      return {
        commitLoadTime: 0,
        connectionInfo: 'h2',
        finishDocumentLoadTime: 0,
        finishLoadTime: 0,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: 0,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: 0,
        startLoadTime: 0,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      };
    };
  }

  // Propagate window.chrome into srcdoc / about:blank iframes.
  // The test does: iframe.srcdoc='...'; document.body.appendChild(iframe);
  // then typeof iframe.contentWindow.chrome.
  // contentWindow is non-configurable in Chromium (WebIDL [Unforgeable]),
  // so we cannot intercept its getter. Instead we intercept DOM insertion
  // methods to patch the iframe's window right after it enters the DOM
  // (which is when contentWindow becomes available) and before the caller
  // can read it.
  try {
    var patchIframe = function(node) {
      if (node instanceof HTMLIFrameElement) {
        try {
          var w = node.contentWindow;
          if (w && typeof w.chrome === 'undefined') {
            w.chrome = window.chrome;
          }
        } catch(e) {}
      }
    };

    var origAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function(child) {
      var result = origAppendChild.call(this, child);
      patchIframe(child);
      return result;
    };

    var origInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function(newNode, refNode) {
      var result = origInsertBefore.call(this, newNode, refNode);
      patchIframe(newNode);
      return result;
    };

    var origReplaceChild = Node.prototype.replaceChild;
    Node.prototype.replaceChild = function(newNode, oldNode) {
      var result = origReplaceChild.call(this, newNode, oldNode);
      patchIframe(newNode);
      return result;
    };

    var origAppend = Element.prototype.append;
    Element.prototype.append = function() {
      origAppend.apply(this, arguments);
      for (var i = 0; i < arguments.length; i++) {
        if (arguments[i] instanceof Node) patchIframe(arguments[i]);
      }
    };

    var origPrepend = Element.prototype.prepend;
    Element.prototype.prepend = function() {
      origPrepend.apply(this, arguments);
      for (var i = 0; i < arguments.length; i++) {
        if (arguments[i] instanceof Node) patchIframe(arguments[i]);
      }
    };
  } catch(e) {}

  // 3. Mock navigator.plugins (standard Chrome PDF plugins)
  try {
    var fakePlugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    ];
    if (navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: function() {
          var arr = fakePlugins.slice();
          arr.item = function(i) { return arr[i] || null; };
          arr.namedItem = function(name) {
            for (var j = 0; j < arr.length; j++) {
              if (arr[j].name === name) return arr[j];
            }
            return null;
          };
          arr.refresh = function() {};
          return arr;
        },
      });
    }
  } catch(e) {}

  // 4. Ensure navigator.languages has at least two entries (Chrome default)
  try {
    if (!navigator.languages || navigator.languages.length < 2) {
      Object.defineProperty(navigator, 'languages', {
        get: function() { return ['en-US', 'en']; },
        configurable: true,
      });
    }
  } catch(e) {}

  // 5. Fix permissions to match Chrome defaults.
  // The test checks both navigator.permissions.query({name:'notifications'}).state
  // AND Notification.permission. In Chrome they are "prompt" and "default".
  // Electron auto-grants notifications so both return "granted".
  // Override on Permissions.prototype (instance property may be non-configurable).
  try {
    var origQuery = Permissions.prototype.query;
    Permissions.prototype.query = function(params) {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return origQuery.call(this, params);
    };
  } catch(e) {}
  // Override Notification.permission to return 'default' (not 'granted')
  try {
    Object.defineProperty(Notification, 'permission', {
      get: function() { return 'default'; },
      configurable: true,
    });
  } catch(e) {}

  // 6. Override navigator.userAgentData — ALWAYS override because Electron's
  // Chromium sets this with an "Electron" brand that triggers bot detectors.
  // We include Clodex as an additional brand for identification.
  try {
    var brands = [
      { brand: 'Chromium', version: '${chromeMajor}' },
      { brand: 'Google Chrome', version: '${chromeMajor}' },
      { brand: 'Not-A.Brand', version: '99' },
    ];
    var uaData = {
      brands: brands,
      mobile: false,
      platform: '${platformName}',
      getHighEntropyValues: function(hints) {
        return Promise.resolve({
          brands: brands,
          mobile: false,
          platform: '${platformName}',
          platformVersion: '',
          architecture: 'x86',
          bitness: '64',
          model: '',
          uaFullVersion: '${chromeMajor}.0.0.0',
          fullVersionList: brands.map(function(b) {
            return { brand: b.brand, version: b.brand === 'Not-A.Brand' ? '99.0.0.0' : '${chromeMajor}.0.0.0' };
          }),
        });
      },
      toJSON: function() {
        return { brands: brands, mobile: false, platform: '${platformName}' };
      },
    };
    Object.defineProperty(navigator, 'userAgentData', {
      get: function() { return uaData; },
      configurable: true,
    });
  } catch(e) {}

  // 7. Ensure navigator.vendor is "Google Inc." (Electron may leave it empty)
  try {
    if (navigator.vendor !== 'Google Inc.') {
      Object.defineProperty(navigator, 'vendor', {
        get: function() { return 'Google Inc.'; },
        configurable: true,
      });
    }
  } catch(e) {}

  // 8. Ensure navigator.webdriver is false
  try {
    if (navigator.webdriver === true) {
      Object.defineProperty(navigator, 'webdriver', {
        get: function() { return false; },
        configurable: true,
      });
    }
  } catch(e) {}
})();`;
}
