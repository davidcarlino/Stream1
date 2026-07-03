const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

/** Read a picked image file as base64 + mime for API upload. */
export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (!ALLOWED.includes(file.type)) {
      reject(new Error('Cover image must be JPEG, PNG or WebP.'));
      return;
    }
    if (file.size > MAX_BYTES) {
      reject(new Error('Cover image must be 2 MB or smaller.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const comma = text.indexOf(',');
      if (comma < 0) {
        reject(new Error('Could not read image.'));
        return;
      }
      const header = text.slice(0, comma);
      const mimeMatch = header.match(/data:(.*?);/);
      resolve({
        imageBase64: text.slice(comma + 1),
        mimeType: (mimeMatch && mimeMatch[1]) || file.type,
      });
    };
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.readAsDataURL(file);
  });
}

export function previewImageFile(file, imgEl) {
  if (!file || !imgEl) return;
  const url = URL.createObjectURL(file);
  imgEl.src = url;
  imgEl.hidden = false;
  imgEl.onload = () => URL.revokeObjectURL(url);
}
