import { useApp, useInput, useStdin } from "ink";

export function useQuit(isActive = true) {
	const { exit } = useApp();
	const { isRawModeSupported } = useStdin();

	useInput(
		(input) => {
			if (input === "q") {
				exit();
			}
		},
		{ isActive: isRawModeSupported === true && isActive },
	);
}
