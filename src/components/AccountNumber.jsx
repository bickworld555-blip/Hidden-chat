import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { formatAccountNumber } from '../accountNumber.js';

// An account's public ID ("ID 482 193 7765", src/accountNumber.js) with a copy button: what people share to be found
// and saved, like a phone number but with no phone attached. Nothing shows while the number is not known yet.
export default function AccountNumber({ number, className = '', copyable = true }) {
  const [copied, setCopied] = useState(false);
  if (!number) return null;
  const shown = formatAccountNumber(number);
  const copy = async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(number);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable: the number stays visible to copy by hand
    }
  };
  return (
    <span className={`account-number ${className}`}>
      <span>ID · <bdi>{shown}</bdi></span>
      {copyable && (
        <button type="button" className="account-number-copy" onClick={copy} aria-label={copied ? 'ID copied' : `Copy ID ${shown}`} title={copied ? 'Copied' : 'Copy ID'}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        </button>
      )}
    </span>
  );
}
