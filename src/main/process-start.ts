import { hardenProcess } from '../core/program-lookup.js';

// First import of every process entry, so it runs before anything that could spawn (ES modules run in import order).
hardenProcess();
