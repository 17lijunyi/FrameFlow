import {useLayoutEffect, useState} from 'react';
import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';

/** One stable action surface shared by the current workspace. */
export default function CapsuleDock({children, className = ''}: {children: ReactNode; className?: string}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setTarget(document.getElementById('frameflow-action-dock')); }, []);
  return target ? createPortal(
    <section className={`capsule-dock ${className}`} data-capsule="actions" aria-label="当前页面操作">{children}</section>,
    target,
  ) : null;
}
