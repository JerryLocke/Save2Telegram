export const SETUP_PAGE_MESSAGES = {
  en: {
    lang: "en",
    title: "{appName} Backend",
    heading: "Welcome to {appName} endpoint",
    endpointDescription: "The backend uploads media to Telegram on behalf of the browser extension, so forwarding can continue after the browser closes and is often more efficient in proxied network environments.",
    endpointLabel: "Forwarding backend URL",
    installExtension: "Install {appName} from Chrome Web Store",
    useEndpoint: "Use this endpoint as forwarding backend",
    extensionNotFound: "Extension not found. Please install the {appName} extension first.",
    missingExtensionId: "Backend EXTENSION_ID is not configured.",
    missingSecret: "Setup secret is missing from this URL.",
    chromeUnavailable: "This browser cannot access the extension messaging API.",
    keyFailed: "Failed to request endpoint key.",
    setupFailed: "Failed to set endpoint.",
    setupDone: "This endpoint has been set."
  },
  zh_CN: {
    lang: "zh-CN",
    title: "{appName} 后端",
    heading: "欢迎使用 {appName} 端点",
    endpointDescription: "此后端会代替浏览器扩展把媒体上传到 Telegram，浏览器关闭后也可继续上传；在代理网络环境中通常能提升转发效率。",
    endpointLabel: "转发后端地址",
    installExtension: "从 Chrome Web Store 安装 {appName}",
    useEndpoint: "使用此端点作为转发后端",
    extensionNotFound: "未找到扩展。请先安装 {appName} 扩展。",
    missingExtensionId: "后端未配置 EXTENSION_ID。",
    missingSecret: "此 URL 缺少设置密钥。",
    chromeUnavailable: "此浏览器无法访问扩展消息 API。",
    keyFailed: "请求端点密钥失败。",
    setupFailed: "设置端点失败。",
    setupDone: "此端点已设置。"
  }
};
