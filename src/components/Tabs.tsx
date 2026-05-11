'use client';

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react';

/**
 * Lightweight client-side Tabs primitive. We intentionally avoid pulling in
 * @radix-ui/react-tabs for V1 since this is the only place we need tabs and
 * we don't yet require its accessibility-oriented keyboard handling. Phase
 * H4+ may swap this for the Radix version once it's added to the bundle.
 *
 * API mirrors the Radix surface so a future swap is a near drop-in:
 *   <Tabs defaultValue="genel">
 *     <TabsList>
 *       <TabsTrigger value="genel">Genel</TabsTrigger>
 *       ...
 *     </TabsList>
 *     <TabsContent value="genel">...</TabsContent>
 *   </Tabs>
 */

interface TabsContextValue {
  value: string;
  setValue: (v: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error('Tabs components must be rendered inside <Tabs>');
  }
  return ctx;
}

export function Tabs({
  defaultValue,
  children,
  className = '',
}: {
  defaultValue: string;
  children: ReactNode;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <TabsContext.Provider value={{ value, setValue }}>
      <div className={`space-y-4 ${className}`}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`flex gap-1 border-b border-slate-700 ${className}`}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  const { value: active, setValue } = useTabs();
  const isActive = active === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={() => setValue(value)}
      className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
        isActive
          ? 'border-blue-500 text-slate-100'
          : 'border-transparent text-slate-400 hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  children,
  className = '',
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const { value: active } = useTabs();
  if (active !== value) return null;
  return (
    <div role="tabpanel" className={`space-y-4 ${className}`}>
      {children}
    </div>
  );
}
