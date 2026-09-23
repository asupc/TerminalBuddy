// 后端桥接服务按域拆分后的统一出口。
// 消费方既有的 `import ... from '../services/tauri'` 路径全部解析到这里。
export * from './bot';
export * from './claudeHook';
export * from './clientData';
export * from './clipboard';
export * from './events';
export * from './fs';
export * from './git';
export * from './profiles';
export * from './settings';
export * from './ssh';
export * from './system';
export * from './templates';
export * from './terminal';
export * from './update';
export * from './web';
export * from './window';
