import { hash } from 'bcryptjs';

/**
 * An inbox password, bcrypt-hashed for Mailpit's SMTP auth file (Genie Mail G3, Tynn #489). bcryptjs is pure JavaScript,
 * bundled into the host; cost 10, the cost G1 measured Mailpit accepting (genie#1712). `$2b$` hashes, which Mailpit's
 * htpasswd reader accepts (G1 measured `$2b$` and `$2y$`).
 */
export const bcryptHash = (password: string): Promise<string> => hash(password, 10);
