import React, { useEffect, useState, useCallback } from 'react';

type MobileDrawerProps = {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
};

function MobileDrawer({ open, onClose, children }: MobileDrawerProps) {
  const [shouldRender, setShouldRender] = useState(open);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsClosing(false);
    } else if (shouldRender) {
      setIsClosing(true);
      const timer = setTimeout(() => {
        setShouldRender(false);
        setIsClosing(false);
      }, 280);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    onClose();
  }, [onClose]);

  if (!shouldRender) return null;

  return (
    <div className={`mobile-drawer-root ${isClosing ? 'is-closing' : ''}`}>
      <button
        type="button"
        className="mobile-drawer-backdrop"
        onClick={handleClose}
        aria-label="Close navigation"
      />
      <div className="mobile-drawer-panel" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export { MobileDrawer };
export default MobileDrawer;
