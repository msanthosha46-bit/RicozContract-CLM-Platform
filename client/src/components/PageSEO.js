import { useEffect } from 'react';
const { updateStructuredData } = require('../seo/updateStructuredData');

const updateMetaContent = (name, content) => {
  let meta = document.head.querySelector(`meta[name="${name}"]`);
  const created = !meta;

  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', name);
    document.head.appendChild(meta);
  }

  const previousContent = meta.getAttribute('content');
  meta.setAttribute('content', content);

  return () => {
    if (created) {
      meta.remove();
    } else if (previousContent === null) {
      meta.removeAttribute('content');
    } else {
      meta.setAttribute('content', previousContent);
    }
  };
};

const updateMetaProperty = (property, content) => {
  let meta = document.head.querySelector(`meta[property="${property}"]`);
  const created = !meta;

  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('property', property);
    document.head.appendChild(meta);
  }

  const previousContent = meta.getAttribute('content');
  meta.setAttribute('content', content);

  return () => {
    if (created) {
      meta.remove();
    } else if (previousContent === null) {
      meta.removeAttribute('content');
    } else {
      meta.setAttribute('content', previousContent);
    }
  };
};

const updateMetaGroup = (attribute, metadata = {}) => {
  const restorers = Object.entries(metadata).map(([key, content]) => (
    attribute === 'property'
      ? updateMetaProperty(key, content)
      : updateMetaContent(key, content)
  ));

  return () => restorers.reverse().forEach((restore) => restore());
};

const updateCanonical = (canonical) => {
  const existingCanonical = document.head.querySelector('link[rel="canonical"]');
  let link = existingCanonical;
  const created = !link && Boolean(canonical);
  const previousHref = link?.getAttribute('href');

  if (canonical) {
    if (!link) {
      link = document.createElement('link');
      link.setAttribute('rel', 'canonical');
      document.head.appendChild(link);
    }
    link.setAttribute('href', canonical);
  } else {
    link?.remove();
  }

  return () => {
    if (created) {
      link.remove();
    } else if (existingCanonical) {
      if (previousHref === null) {
        existingCanonical.removeAttribute('href');
      } else {
        existingCanonical.setAttribute('href', previousHref);
      }
      if (!existingCanonical.isConnected) document.head.appendChild(existingCanonical);
    }
  };
};

const PageSEO = ({ title, description, robots, canonical, openGraph, twitter, structuredData }) => {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;

    const restoreDescription = updateMetaContent('description', description);
    const restoreRobots = updateMetaContent('robots', robots);
    const restoreCanonical = updateCanonical(canonical);
    const restoreOpenGraph = updateMetaGroup('property', openGraph);
    const restoreTwitter = updateMetaGroup('name', twitter);
    const restoreStructuredData = updateStructuredData(structuredData, document.head);

    return () => {
      restoreStructuredData();
      restoreTwitter();
      restoreOpenGraph();
      restoreCanonical();
      restoreRobots();
      restoreDescription();
      document.title = previousTitle;
    };
  }, [title, description, robots, canonical, openGraph, twitter, structuredData]);

  return null;
};

export default PageSEO;
