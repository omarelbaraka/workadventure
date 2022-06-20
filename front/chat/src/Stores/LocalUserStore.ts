import {UserData} from "../Messages/JsonMessages/ChatData";
import {writable} from "svelte/store";

const uuidKey = "uuid";
const emailKey = "email";
const playUriKey = "playUri";


function createUserStore() {
    const { subscribe, update, set } = writable<UserData>();

    return {
        subscribe,
        update,
        set
    };
}

export const userStore = createUserStore();


class LocalUserStore {
    setUserData(data: UserData): void {
        localStorage.setItem(uuidKey, data.uuid);
        if(data.email) localStorage.setItem(emailKey, data.email);
        localStorage.setItem(playUriKey, data.playUri);
    }

    getUserData(): UserData | null {
        return {
            uuid: localStorage.getItem(uuidKey) || "",
            email: localStorage.getItem(emailKey) || undefined,
            playUri: localStorage.getItem(playUriKey) || ""
        };
    }
}

export const localUserStore = new LocalUserStore();