import { useApp, useInput, useStdin } from "ink";

export function useQuit(isActive = true) {
	const { exit } = useApp();
	const { isRawModeSupported } = useStdin();

	useInput(
		(input) => {
			if (input === "q") {
				exit();
				process.exit(0);
			}
		},
		{ isActive: isRawModeSupported === true && isActive },
	);
}
