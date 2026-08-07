// vitest 测试里用 `?case=...` query string 强制让同一个模块在不同 case 间独立 import，
// TS 不认识这种 specifier。这里给带 `?case=` 后缀的模块路径声明通配。
declare module '*?case=missing'
declare module '*?case=ok'
declare module '*?case=no-tty'
declare module '*?case=success'
declare module '*?case=ansi'
