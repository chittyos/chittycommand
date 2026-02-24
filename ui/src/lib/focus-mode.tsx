import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface FocusModeContextType {
  focusMode: boolean;
  toggleFocusMode: () => void;
}

const FocusModeContext = createContext<FocusModeContextType>({
  focusMode: true,
  toggleFocusMode: () => {},
});

export function FocusModeProvider({ children }: { children: ReactNode }) {
  const [focusMode, setFocusMode] = useState(() => {
    const saved = localStorage.getItem('chittycommand_focus_mode');
    return saved !== null ? saved === 'true' : true; // default ON
  });

  const toggleFocusMode = useCallback(() => {
    setFocusMode((prev) => {
      const next = !prev;
      localStorage.setItem('chittycommand_focus_mode', String(next));
      return next;
    });
  }, []);

  return (
    <FocusModeContext.Provider value={{ focusMode, toggleFocusMode }}>
      {children}
    </FocusModeContext.Provider>
  );
}

export function useFocusMode() {
  return useContext(FocusModeContext);
}
