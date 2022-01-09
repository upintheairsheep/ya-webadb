import { AdbCommandBase } from "./base";

export interface AdbBackupOptions {
    apps: string[] | 'all' | 'all-including-system';
    apks: boolean;
    obbs: boolean;
    shared: boolean;
    widgets: boolean;
    compress: boolean;
    user: number;
}

export class AdbBackup extends AdbCommandBase {

}
