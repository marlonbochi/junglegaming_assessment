export interface AppLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export const noopLogger: AppLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
