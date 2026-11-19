// aria-live 状态区的发布函数：由 AppShell 提供，任意组件可调用 announce('已保存')。
import { createContext, useContext } from 'react';

export type Announce = (message: string) => void;

export const AnnounceContext = createContext<Announce>(() => undefined);

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}
