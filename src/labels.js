// Chat label colours (WhatsApp Business has 20; the server stores the index 0–19).
export const LABEL_PALETTE = Object.freeze([
  '#25a8e0', '#f16a85', '#f0b330', '#6bcb77', '#a77de8', '#2bb3a5', '#ff8a4c', '#7f8fa6', '#e84a5f', '#4f9cf5',
  '#c9a227', '#3fb950', '#d16ba5', '#00a3a3', '#ff6f61', '#8e7cc3', '#5aa469', '#e0a458', '#4b8bbe', '#b56576',
]);

export const labelColor = (index) => LABEL_PALETTE[Number.isInteger(index) && index >= 0 && index < LABEL_PALETTE.length ? index : 0];
