import React from 'react';

type MobileCardProps = {
  title: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
};

type MobileFieldProps = {
  label: React.ReactNode;
  value: React.ReactNode;
};

export function MobileCard({ title, actions, children }: MobileCardProps) {
  return (
    <div className="mobile-card">
      <div className="mobile-card-header">
        <div className="mobile-card-title">{title}</div>
        {actions ? <div className="mobile-card-actions">{actions}</div> : null}
      </div>
      <div className="mobile-card-body">{children}</div>
    </div>
  );
}

export function MobileField({ label, value }: MobileFieldProps) {
  return (
    <div className="mobile-field">
      <div className="mobile-field-label">{label}</div>
      <div className="mobile-field-value">{value}</div>
    </div>
  );
}
