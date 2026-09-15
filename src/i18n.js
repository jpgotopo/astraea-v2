import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enTranslation from './locales/en.json';
import esTranslation from './locales/es.json';
import idTranslation from './locales/id.json';

i18n
    // Detects user language
    .use(LanguageDetector)
    // Passes i18n down to react-i18next
    .use(initReactI18next)
    .init({
        resources: {
            en: {
                translation: enTranslation,
            },
            es: {
                translation: esTranslation,
            },
            id: {
                translation: idTranslation,
            },
        },
        fallbackLng: 'en', // Use English if the detected language is not available
        interpolation: {
            escapeValue: false, // React already safe from xss
        },
    });

export default i18n;
