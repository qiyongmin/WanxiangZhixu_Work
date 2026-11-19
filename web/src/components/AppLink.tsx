import type { AnchorHTMLAttributes } from 'react';
import { navigate, shouldIntercept, withBase } from '../lib/router';

interface Props extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** 应用内路径（不含 /app 前缀）。渲染为真实 <a href>，Ctrl/中键等保留浏览器行为。 */
  to: string;
}

export function AppLink({ to, onClick, target, ...rest }: Props) {
  return (
    <a
      {...rest}
      href={withBase(to)}
      target={target}
      onClick={(event) => {
        onClick?.(event);
        if (shouldIntercept(event, target)) {
          event.preventDefault();
          navigate(to);
        }
      }}
    />
  );
}
