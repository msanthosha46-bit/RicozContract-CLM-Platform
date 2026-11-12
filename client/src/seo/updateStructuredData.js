'use strict';

const activeUpdates = new WeakMap();

const updateStructuredData = (structuredData, head) => {
  let script = head.querySelector('#ricoz-page-structured-data');

  if (!structuredData) {
    if (script) activeUpdates.delete(script);
    script?.remove();
    return () => {};
  }

  if (!script) {
    script = head.ownerDocument.createElement('script');
    script.id = 'ricoz-page-structured-data';
    script.type = 'application/ld+json';
    head.appendChild(script);
  }

  script.textContent = JSON.stringify(structuredData).replace(/</g, '\\u003c');
  const update = {};
  activeUpdates.set(script, update);

  return () => {
    if (activeUpdates.get(script) === update) {
      activeUpdates.delete(script);
      script.remove();
    }
  };
};

module.exports = { updateStructuredData };
