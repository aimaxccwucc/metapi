import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedVisibility } from './useAnimatedVisibility.js';

type CenteredModalProps = {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: number;
  bodyStyle?: React.CSSProperties;
};

export default function CenteredModal({
  open,
  onClose,
  title,
  children,
  footer,
  maxWidth = 860,
  bodyStyle,
}: CenteredModalProps) {
  const presence = useAnimatedVisibility(open, 220);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [open, onClose]);

  if (!presence.shouldRender) return null;

  const modal = (
    <div
      className={`modal-backdrop ${presence.isVisible ? '' : 'is-closing'}`.trim()}
      onClick={onClose}
    >
      <div
        className={`modal-content ${presence.isVisible ? '' : 'is-closing'}`.trim()}
        style={{ maxWidth }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">{title}</div>
        <div className="modal-body" style={bodyStyle}>
          {children}
        </div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
}
