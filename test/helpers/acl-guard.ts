export const ACL_FAILURE = 'PRIVATE_CREDENTIAL_ACL_FAILURE';

export function aclLinesOf(_warned: readonly (readonly unknown[])[]): (readonly unknown[])[] {
    return [];
}

export function unexplainedAclFailures(_testPath: string | undefined, _lines: readonly (readonly unknown[])[]): (readonly unknown[])[] {
    return [];
}
