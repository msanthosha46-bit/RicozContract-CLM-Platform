import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

const stripMargin = (className = '') => className.replace(/\bmt-\S+/g, '').replace(/\s+/g, ' ').trim();
const extractMargin = (className = '') => (className.match(/\bmt-[^\s]+/) || [''])[0];

const PasswordInput = ({
  value,
  onChange,
  name,
  id,
  autoComplete,
  minLength,
  placeholder,
  required,
  className = ''
}) => {
  const [visible, setVisible] = useState(false);
  const margin = extractMargin(className);
  const inputClasses = `${stripMargin(className)} pr-11`;
  const toggleLabel = visible ? 'Hide password' : 'Show password';

  return (
    <div className={`relative ${margin}`}>
      <input
        id={id}
        name={name}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        minLength={minLength}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={onChange}
        className={inputClasses}
      />
      <button
        type="button"
        tabIndex={0}
        aria-label={toggleLabel}
        aria-pressed={visible}
        title={toggleLabel}
        onClick={() => setVisible((current) => !current)}
        className="absolute inset-y-0 right-0 flex items-center rounded-r-xl px-3 text-slate-400 outline-none transition hover:text-[#475569] focus:text-[#475569] focus:ring-2 focus:ring-red-100"
      >
        {visible ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </button>
    </div>
  );
};

export default PasswordInput;