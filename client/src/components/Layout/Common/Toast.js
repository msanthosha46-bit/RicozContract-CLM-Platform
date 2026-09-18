import React, { useEffect } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';

const Toast = ({ type = 'success', message, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(() => onClose && onClose(), 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const styles = {
    success: 'border-[#bbf7d0] bg-[#eaf8f1] text-[#15803d]',
    error: 'border-[#fecdd3] bg-[#fff1f2] text-[#be123c]',
    info: 'border-[#bfdbfe] bg-[#eaf1ff] text-[#1d4ed8]'
  };

  const icons = {
    success: <CheckCircle2 className="h-4 w-4" />,
    error: <AlertCircle className="h-4 w-4" />,
    info: <AlertCircle className="h-4 w-4" />
  };

  return (
    <div className={`fixed right-5 top-5 z-50 flex max-w-sm items-center gap-3 rounded-xl border px-4 py-3 shadow-lg ${styles[type]}`}>
      <div className="flex-shrink-0">{icons[type]}</div>
      <div className="flex-1 text-sm font-medium">{message}</div>
      <button onClick={onClose} className="rounded-md p-1 hover:bg-black/5">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};

export default Toast;
